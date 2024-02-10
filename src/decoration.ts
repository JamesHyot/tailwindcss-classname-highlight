/* eslint-disable ts/no-require-imports */
/* eslint-disable ts/no-var-requires */
import path from 'node:path'
import fs from 'node:fs'
import * as vscode from 'vscode'
import micromatch from 'micromatch'
import fg from 'fast-glob'

const CHECK_CONTEXT_MESSAGE_PREFIX = 'Check context failed: '
const LIMITED_CACHE_SIZE = 50

type GenerateRules = Array<[
  Record<string, unknown>,
  {
    raws: {
      tailwind: {
        candidate: string
      }
    }
  },
]>

interface NumberRange {
  start: number
  end: number
}

interface ExtractResult {
  index: number
  result: NumberRange[]
}

export class Decoration {
  workspacePath: string
  tailwindConfigPath: string = ''
  tailwindConfigFolderPath: string = ''
  tailwindContext: any
  tailwindLibPath: string = ''

  textContentHashCache: Array<[string, NumberRange[]]> = []
  latestDecoratedHash: string = ''

  extContext: vscode.ExtensionContext
  decorationType = vscode.window.createTextEditorDecorationType({ textDecoration: 'none; border-bottom: 1px dashed;' })
  logger = vscode.window.createOutputChannel('Tailwind CSS ClassName Highlight')

  constructor(extContext: vscode.ExtensionContext) {
    this.extContext = extContext
    this.extContext.subscriptions.push(this.decorationType)
    this.extContext.subscriptions.push(this.logger)

    this.workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? ''
    if (!this.workspacePath)
      throw new Error('No workspace found')

    this.updateTailwindConfigPath()

    if (this.locateTailwindLibPath()) {
      this.updateTailwindContext()
      this.setupFileWatcher()
    }
  }

  private updateTailwindConfigPath() {
    const configPath = fg
      .globSync(
        './**/tailwind.config.{js,cjs,mjs,ts}',
        {
          cwd: this.workspacePath,
          ignore: ['**/node_modules/**'],
        },
      )
      .map(p => path.join(this.workspacePath, p))
      .find(p => fs.existsSync(p))!

    this.logger.appendLine(`Tailwind CSS config file found at ${configPath}`)
    this.tailwindConfigPath = configPath
    this.tailwindConfigFolderPath = path.dirname(this.tailwindConfigPath)
  }

  private locateTailwindLibPath() {
    try {
      require(`${this.workspacePath}/node_modules/tailwindcss/resolveConfig.js`)
      this.tailwindLibPath = this.workspacePath
    }
    catch {
      try {
        require(`${this.tailwindConfigFolderPath}/node_modules/tailwindcss/resolveConfig.js`)
        this.tailwindLibPath = this.tailwindConfigFolderPath
      }
      catch {
        this.logger.appendLine('Tailwind CSS library path not found, you may need to install Tailwind CSS in your workspace')
        return false
      }
    }
    return true
  }

  private updateTailwindContext() {
    const now = Date.now()
    this.logger.appendLine('Updating Tailwind CSS context')

    delete require.cache[require.resolve(this.tailwindConfigPath)]
    const { createContext } = require(`${this.tailwindLibPath}/node_modules/tailwindcss/lib/lib/setupContextUtils.js`)
    const { loadConfig } = require(`${this.tailwindLibPath}/node_modules/tailwindcss/lib/lib/load-config.js`)
    const resolveConfig = require(`${this.tailwindLibPath}/node_modules/tailwindcss/resolveConfig.js`)
    this.tailwindContext = createContext(resolveConfig(loadConfig(this.tailwindConfigPath)))

    this.logger.appendLine(`Tailwind CSS context updated in ${Date.now() - now}ms`)
  }

  private setupFileWatcher() {
    this.extContext.subscriptions.push(
      vscode.workspace.createFileSystemWatcher(this.tailwindConfigPath)
        .onDidChange(() => {
          this.logger.appendLine('Tailwind CSS config file changed, trying to update context')
          this.updateTailwindContext()
        }),
    )
  }

  decorate(openEditor?: vscode.TextEditor | null | undefined) {
    if (!openEditor || !this.isFileMatched(openEditor.document.uri.fsPath))
      return

    const text = openEditor.document.getText()

    let crypto: typeof import('node:crypto') | undefined
    try {
      crypto = require('node:crypto')
    }
    catch (err) {
    }

    const currentTextContentHash = crypto
      ? crypto.createHash('md5').update(text).digest('hex')
      : ''

    if (crypto) {
      if (currentTextContentHash === this.latestDecoratedHash)
        return
      this.latestDecoratedHash = currentTextContentHash
    }

    let numberRange: NumberRange[] = []

    if (crypto) {
      const cached = this.textContentHashCache.find(([hash]) => hash === currentTextContentHash)
      if (cached) {
        numberRange = cached[1]
      }
      else {
        numberRange = this.extract(text)
        this.textContentHashCache.unshift([currentTextContentHash, numberRange])
        this.textContentHashCache.length = Math.min(this.textContentHashCache.length, LIMITED_CACHE_SIZE)
      }
    }
    else {
      numberRange = this.extract(text)
    }

    openEditor.setDecorations(
      this.decorationType,
      numberRange
        .map(({ start, end }) => new vscode.Range(
          openEditor.document.positionAt(start),
          openEditor.document.positionAt(end),
        )),
    )
  }

  private isFileMatched(filePath: string) {
    const relativeFilePath = path.relative(this.tailwindConfigFolderPath, filePath)
    const contentFilesPath = this.tailwindContext?.tailwindConfig?.content?.files ?? [] as string[]
    return micromatch.isMatch(relativeFilePath, contentFilesPath)
  }

  private extract(text: string) {
    const { defaultExtractor } = require(`${this.tailwindLibPath}/node_modules/tailwindcss/lib/lib/defaultExtractor.js`)
    const { generateRules } = require(`${this.tailwindLibPath}/node_modules/tailwindcss/lib/lib/generateRules.js`)
    const generatedRules = generateRules(defaultExtractor(this.tailwindContext)(text), this.tailwindContext) as GenerateRules
    const generatedCandidates = generatedRules.map(([, { raws: { tailwind: { candidate } } }]) => candidate)

    return generatedCandidates.reduce<ExtractResult>(
      (acc, value) => {
        const start = text.indexOf(value, acc.index)
        const end = start + value.length
        acc.result.push({ start, end })
        acc.index = end
        return acc
      },
      { index: 0, result: [] },
    ).result
  }

  checkContext() {
    if (!this.tailwindLibPath) {
      this.logger.appendLine(`${CHECK_CONTEXT_MESSAGE_PREFIX}Tailwind CSS library path not found`)
      return false
    }

    if (!this.tailwindContext) {
      this.logger.appendLine(`${CHECK_CONTEXT_MESSAGE_PREFIX}Tailwind CSS context not found`)
      return false
    }

    return true
  }
}
