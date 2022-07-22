import chalk from 'chalk'
import fs from 'fs'
import os from 'os'
import strip from 'strip-ansi'
import { CustomPayload } from 'vite'
// import { URI } from 'vscode-uri'
import vscodeUri from 'vscode-uri'
const { URI } = vscodeUri
import { isMainThread, parentPort, threadId } from 'worker_threads'
import { createRequire } from 'module'
const _require = createRequire(import.meta.url)
import { codeFrameColumns, SourceLocation } from '@babel/code-frame'

import { WS_CHECKER_ERROR_EVENT } from './client/index.js'
import { ACTION_TYPES, DiagnosticToRuntime, DiagnosticLevel } from './types.js'

import type { Range } from 'vscode-languageclient'
import type { ESLint } from 'eslint'
import type {
  Diagnostic as LspDiagnostic,
  PublishDiagnosticsParams,
} from 'vscode-languageclient/node'

import type {
  Diagnostic as TsDiagnostic,
  flattenDiagnosticMessageText as flattenDiagnosticMessageTextType,
  LineAndCharacter,
} from 'typescript'

export interface NormalizedDiagnostic {
  /** error message */
  message?: string
  /** error conclusion */
  conclusion?: string
  /** error stack */
  stack?: string | string[]
  /** file name */
  id?: string
  /** checker diagnostic source */
  checker: string
  /** raw code frame generated by @babel/code-frame */
  codeFrame?: string
  /** code frame, but striped */
  stripedCodeFrame?: string
  /** error code location */
  loc?: SourceLocation
  /** error level */
  level?: DiagnosticLevel
}

const defaultLogLevel = [
  DiagnosticLevel.Warning,
  DiagnosticLevel.Error,
  DiagnosticLevel.Suggestion,
  DiagnosticLevel.Message,
]

export function filterLogLevel(
  diagnostics: NormalizedDiagnostic,
  level?: DiagnosticLevel[]
): NormalizedDiagnostic | null
export function filterLogLevel(
  diagnostics: NormalizedDiagnostic[],
  level?: DiagnosticLevel[]
): NormalizedDiagnostic[]
export function filterLogLevel(
  diagnostics: NormalizedDiagnostic | NormalizedDiagnostic[],
  level: DiagnosticLevel[] = defaultLogLevel
): NormalizedDiagnostic | null | NormalizedDiagnostic[] {
  if (Array.isArray(diagnostics)) {
    return diagnostics.filter((d) => {
      if (typeof d.level !== 'number') return false
      return level.includes(d.level)
    })
  } else {
    if (!diagnostics.level) return null
    return level.includes(diagnostics.level) ? diagnostics : null
  }
}

export function diagnosticToTerminalLog(
  d: NormalizedDiagnostic,
  name?: 'TypeScript' | 'vue-tsc' | 'VLS' | 'ESLint'
): string {
  const nameInLabel = name ? `(${name})` : ''
  const boldBlack = chalk.bold.rgb(0, 0, 0)

  const labelMap: Record<DiagnosticLevel, string> = {
    [DiagnosticLevel.Error]: boldBlack.bgRedBright(` ERROR${nameInLabel} `),
    [DiagnosticLevel.Warning]: boldBlack.bgYellowBright(` WARNING${nameInLabel} `),
    [DiagnosticLevel.Suggestion]: boldBlack.bgBlueBright(` SUGGESTION${nameInLabel} `),
    [DiagnosticLevel.Message]: boldBlack.bgCyanBright(` MESSAGE${nameInLabel} `),
  }

  const levelLabel = labelMap[d.level ?? DiagnosticLevel.Error]
  const fileLabel = boldBlack.bgCyanBright(' FILE ') + ' '
  const position = d.loc
    ? chalk.yellow(d.loc.start.line) + ':' + chalk.yellow(d.loc.start.column)
    : ''

  return [
    levelLabel + ' ' + d.message,
    fileLabel + d.id + ':' + position + os.EOL,
    d.codeFrame + os.EOL,
    d.conclusion,
  ]
    .filter(Boolean)
    .join(os.EOL)
}

export function diagnosticToRuntimeError(d: NormalizedDiagnostic): DiagnosticToRuntime
export function diagnosticToRuntimeError(d: NormalizedDiagnostic[]): DiagnosticToRuntime[]
export function diagnosticToRuntimeError(
  diagnostics: NormalizedDiagnostic | NormalizedDiagnostic[]
): DiagnosticToRuntime | DiagnosticToRuntime[] {
  const diagnosticsArray = Array.isArray(diagnostics) ? diagnostics : [diagnostics]

  const results: DiagnosticToRuntime[] = diagnosticsArray.map((d) => {
    let loc: DiagnosticToRuntime['loc']
    if (d.loc) {
      loc = {
        file: d.id,
        line: d.loc.start.line,
        column: typeof d.loc.start.column === 'number' ? d.loc.start.column : 0,
      }
    }

    return {
      message: d.message ?? '',
      stack:
        typeof d.stack === 'string' ? d.stack : Array.isArray(d.stack) ? d.stack.join(os.EOL) : '',
      id: d.id,
      frame: d.stripedCodeFrame,
      checkerId: d.checker,
      level: d.level,
      loc,
    }
  })

  return Array.isArray(diagnostics) ? results : results[0]
}

export function toViteCustomPayload(id: string, diagnostics: DiagnosticToRuntime[]): CustomPayload {
  return {
    type: 'custom',
    event: WS_CHECKER_ERROR_EVENT,
    data: {
      checkerId: id,
      diagnostics,
    },
  }
}

export function createFrame({
  source,
  location,
}: {
  /** file source code */
  source: string
  location: SourceLocation
}) {
  const frame = codeFrameColumns(source, location, {
    // worker tty did not fork parent process stdout, let's make a workaround
    forceColor: true,
  })
    .split('\n')
    .map((line) => '  ' + line)
    .join(os.EOL)

  return frame
}

export function tsLocationToBabelLocation(
  tsLoc: Record<'start' | 'end', LineAndCharacter /** 0-based */>
): SourceLocation {
  return {
    start: { line: tsLoc.start.line + 1, column: tsLoc.start.character + 1 },
    end: { line: tsLoc.end.line + 1, column: tsLoc.end.character + 1 },
  }
}

export function wrapCheckerSummary(checkerName: string, rawSummary: string): string {
  return `[${checkerName}] ${rawSummary}`
}

export function composeCheckerSummary(
  checkerName: string,
  errorCount: number,
  warningCount: number
): string {
  const message = `Found ${errorCount} error${
    errorCount > 1 ? 's' : ''
  } and ${warningCount} warning${warningCount > 1 ? 's' : ''}`

  const hasError = errorCount > 0
  const hasWarning = warningCount > 0
  const color = hasError ? 'red' : hasWarning ? 'yellow' : 'green'
  return chalk[color](wrapCheckerSummary(checkerName, message))
}

/* ------------------------------- TypeScript ------------------------------- */

export function normalizeTsDiagnostic(d: TsDiagnostic): NormalizedDiagnostic {
  const fileName = d.file?.fileName
  const {
    flattenDiagnosticMessageText,
  }: {
    flattenDiagnosticMessageText: typeof flattenDiagnosticMessageTextType
  } = _require('typescript')

  const message = flattenDiagnosticMessageText(d.messageText, os.EOL)

  let loc: SourceLocation | undefined
  const pos = d.start === undefined ? null : d.file?.getLineAndCharacterOfPosition?.(d.start)
  if (pos && d.file && typeof d.start === 'number' && typeof d.length === 'number') {
    loc = tsLocationToBabelLocation({
      start: d.file?.getLineAndCharacterOfPosition(d.start),
      end: d.file?.getLineAndCharacterOfPosition(d.start + d.length),
    })
  }

  let codeFrame: string | undefined
  if (loc) {
    codeFrame = createFrame({
      source: d.file!.text,
      location: loc,
    })
  }

  return {
    message,
    conclusion: '',
    codeFrame,
    stripedCodeFrame: codeFrame && strip(codeFrame),
    id: fileName,
    checker: 'TypeScript',
    loc,
    level: d.category as any as DiagnosticLevel,
  }
}

/* ----------------------------------- LSP ---------------------------------- */

export function normalizeLspDiagnostic({
  diagnostic,
  absFilePath,
  fileText,
}: {
  diagnostic: LspDiagnostic
  absFilePath: string
  fileText: string
}): NormalizedDiagnostic {
  let level = DiagnosticLevel.Error
  const loc = lspRange2Location(diagnostic.range)
  const codeFrame = codeFrameColumns(fileText, loc)

  switch (diagnostic.severity) {
    case 1: // Error
      level = DiagnosticLevel.Error
      break
    case 2: // Warning
      level = DiagnosticLevel.Warning
      break
    case 3: // Information
      level = DiagnosticLevel.Message
      break
    case 4: // Hint
      level = DiagnosticLevel.Suggestion
      break
  }

  return {
    message: diagnostic.message.trim(),
    conclusion: '',
    codeFrame,
    stripedCodeFrame: codeFrame && strip(codeFrame),
    id: absFilePath,
    checker: 'VLS',
    loc,
    level,
  }
}

export async function normalizePublishDiagnosticParams(
  publishDiagnostics: PublishDiagnosticsParams
): Promise<NormalizedDiagnostic[]> {
  const diagnostics = publishDiagnostics.diagnostics
  const absFilePath = uriToAbsPath(publishDiagnostics.uri)
  const { readFile } = fs.promises
  const fileText = await readFile(absFilePath, 'utf-8')

  const res = diagnostics.map((d) => {
    return normalizeLspDiagnostic({
      diagnostic: d,
      absFilePath,
      fileText,
    })
  })

  return res
}

export function uriToAbsPath(documentUri: string): string {
  return URI.parse(documentUri).fsPath
}

export function lspRange2Location(range: Range): SourceLocation {
  return {
    start: {
      line: range.start.line + 1,
      column: range.start.character + 1,
    },
    end: {
      line: range.end.line + 1,
      column: range.end.character + 1,
    },
  }
}

/* --------------------------------- vue-tsc -------------------------------- */

export function normalizeVueTscDiagnostic(d: TsDiagnostic): NormalizedDiagnostic {
  const diagnostic = normalizeTsDiagnostic(d)
  diagnostic.checker = 'vue-tsc'
  return diagnostic
}

/* --------------------------------- ESLint --------------------------------- */

const isNormalizedDiagnostic = (
  d: NormalizedDiagnostic | null | undefined
): d is NormalizedDiagnostic => {
  return Boolean(d)
}

export function normalizeEslintDiagnostic(diagnostic: ESLint.LintResult): NormalizedDiagnostic[] {
  return diagnostic.messages
    .map((d) => {
      let level = DiagnosticLevel.Error
      switch (d.severity) {
        case 0: // off, ignore this
          level = DiagnosticLevel.Error
          return null
        case 1: // warn
          level = DiagnosticLevel.Warning
          break
        case 2: // error
          level = DiagnosticLevel.Error
          break
      }

      const loc: SourceLocation = {
        start: {
          line: d.line,
          column: d.column,
        },
        end: {
          line: d.endLine || 0,
          column: d.endColumn,
        },
      }

      const codeFrame = createFrame({
        source: diagnostic.source ?? '',
        location: loc,
      })

      return {
        message: `${d.message} (${d.ruleId})`,
        conclusion: '',
        codeFrame,
        stripedCodeFrame: codeFrame && strip(codeFrame),
        id: diagnostic.filePath,
        checker: 'ESLint',
        loc,
        level,
      } as any as NormalizedDiagnostic
    })
    .filter(isNormalizedDiagnostic)
}

/* ------------------------------ miscellaneous ----------------------------- */
export function ensureCall(callback: CallableFunction) {
  setTimeout(() => {
    callback()
  })
}

export function consoleLog(value: string) {
  if (isMainThread || (threadId === 1 && process.env.VITEST)) {
    console.log(value)
  } else {
    parentPort?.postMessage({
      type: ACTION_TYPES.console,
      payload: value,
    })
  }
}
