import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Book, BookSwitchResult, ConfigValue } from '@ledger/plugin-contract'
import { AppError } from './errors.js'
import type { BookProvider, ConfigProvider, StorageProvider } from './core-services.js'

const OWNER = 'core.book'
const CATALOG_KEY = 'catalog'
const SNAPSHOT_DATABASE = 'ledger.db'
const SNAPSHOT_CONFIG = 'ledger.config.json'
const STATE_FILE = 'state.json'
const STATE_FILES = ['plugins.json', 'ui-plugins.json'] as const

interface BookCatalog {
  version: 1
  currentBookId?: string
  books: Book[]
}

interface BookStateManifest {
  version: 1
  files: Record<(typeof STATE_FILES)[number], boolean>
}

/**
 * Book Core：一个账本是一份完整项目业务状态，而非 Entry 的分区字段。
 *
 * 账本内容保存在独立目录；目录和当前账本指针保存在 Storage Core 的控制面，
 * 后者不参与账本导入，因此切换账本不会让账本目录本身回退或消失。
 */
export class BookCore implements BookProvider {
  private readonly dataDir: string
  private readonly booksDir: string
  private readonly configPath: string

  constructor(options: {
    storage: StorageProvider
    config: ConfigProvider
    dataDir: string
    projectRoot: string
  }) {
    this.storage = options.storage
    this.config = options.config
    this.dataDir = resolve(options.dataDir)
    this.booksDir = join(this.dataDir, 'books')
    this.configPath = options.config.status().filePath || join(resolve(options.projectRoot), 'ledger.config.json')
  }

  private readonly storage: StorageProvider
  private readonly config: ConfigProvider

  async create(input: { name: string }): Promise<Book> {
    const name = requireName(input.name)
    const catalog = this.catalog()
    if (catalog.books.some((book) => book.name === name)) {
      throw new AppError('BOOK_NAME_TAKEN', `book name "${name}" already exists`)
    }
    const now = Date.now()
    const book: Book = { id: randomUUID(), name, createdAt: now, updatedAt: now }
    const dir = this.bookDir(book.id)
    await mkdir(dir, { recursive: true })
    try {
      await this.storage.exportAll({ destination: join(dir, SNAPSHOT_DATABASE) })
      await this.captureConfig(dir)
      await this.captureStateFiles(dir)
      catalog.books.push(book)
      catalog.currentBookId = book.id
      this.saveCatalog(catalog)
      return { ...book }
    } catch (error) {
      await rm(dir, { recursive: true, force: true })
      throw error
    }
  }

  async get(id: string): Promise<Book> {
    return { ...this.findBook(id) }
  }

  async list(): Promise<Book[]> {
    return this.catalog().books.map((book) => ({ ...book })).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async current(): Promise<Book | undefined> {
    const catalog = this.catalog()
    const book = catalog.currentBookId ? catalog.books.find((item) => item.id === catalog.currentBookId) : undefined
    return book ? { ...book } : undefined
  }

  async delete(id: string): Promise<void> {
    const catalog = this.catalog()
    const book = this.findBook(id, catalog)
    if (catalog.currentBookId === book.id) {
      throw new AppError('BOOK_ACTIVE', `book "${book.name}" is active; switch to another book before deleting it`)
    }
    await rm(this.bookDir(book.id), { recursive: true, force: true })
    catalog.books = catalog.books.filter((item) => item.id !== book.id)
    this.saveCatalog(catalog)
  }

  async switch(id: string): Promise<BookSwitchResult> {
    const catalog = this.catalog()
    const book = this.findBook(id, catalog)
    const dir = this.bookDir(book.id)
    const imported = await this.storage.importAll(join(dir, SNAPSHOT_DATABASE), { createSafetyBackup: true })
    const configReloaded = await this.restoreConfig(dir)
    await this.restoreStateFiles(dir)
    catalog.currentBookId = book.id
    this.saveCatalog(catalog)
    return {
      book: { ...book },
      configReloaded,
      // 数据库、插件注册清单与配置均已切换；常驻 host 应重启以重建全部 L1/L2 运行态。
      restartRequired: true,
      ...(imported.safetyBackup ? { safetyBackup: imported.safetyBackup } : {}),
    }
  }

  private catalog(): BookCatalog {
    const stored = this.storage.getProject(OWNER, CATALOG_KEY) as BookCatalog | undefined
    if (!stored) return { version: 1, books: [] }
    if (stored.version !== 1 || !Array.isArray(stored.books)) {
      throw new AppError('INTERNAL', 'book catalog is malformed')
    }
    return {
      version: 1,
      ...(typeof stored.currentBookId === 'string' ? { currentBookId: stored.currentBookId } : {}),
      books: stored.books.map((book) => ({ ...book })),
    }
  }

  private saveCatalog(catalog: BookCatalog): void {
    this.storage.setProject(OWNER, CATALOG_KEY, catalog as unknown as ConfigValue)
  }

  private findBook(id: string, catalog = this.catalog()): Book {
    if (typeof id !== 'string' || id.length === 0) {
      throw new AppError('VALIDATION_ERROR', 'payload.id must be a non-empty string')
    }
    const book = catalog.books.find((item) => item.id === id)
    if (!book) throw new AppError('BOOK_NOT_FOUND', `book "${id}" not found`)
    return book
  }

  private bookDir(id: string): string {
    return join(this.booksDir, id)
  }

  private async captureConfig(dir: string): Promise<void> {
    try {
      await copyFile(this.configPath, join(dir, SNAPSHOT_CONFIG))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await writeFile(join(dir, SNAPSHOT_CONFIG), JSON.stringify(this.config.snapshot(), null, 2) + '\n', 'utf8')
    }
  }

  private async captureStateFiles(dir: string): Promise<void> {
    const files = {} as BookStateManifest['files']
    for (const file of STATE_FILES) {
      try {
        await copyFile(join(this.dataDir, file), join(dir, file))
        files[file] = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        files[file] = false
      }
    }
    await writeFile(join(dir, STATE_FILE), JSON.stringify({ version: 1, files }, null, 2) + '\n', 'utf8')
  }

  private async restoreConfig(dir: string): Promise<boolean> {
    const snapshotPath = join(dir, SNAPSHOT_CONFIG)
    let snapshot: Record<string, unknown>
    try {
      snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as Record<string, unknown>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw new AppError('INTERNAL', `book configuration is invalid: ${error instanceof Error ? error.message : String(error)}`)
    }
    // storage.dataDir 决定 Book Core 与控制面所在位置，是启动锚点而非账本内容。
    // 账本切换恢复其余项目设置，保留当前锚点以避免重启后找不到账本目录。
    const current = await readJsonObject(this.configPath)
    if (isObject(current['storage']) && isObject(snapshot['storage'])) {
      snapshot['storage'] = { ...snapshot['storage'], dataDir: current['storage']['dataDir'] }
    }
    await writeFile(this.configPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')
    if (!this.config.reload) return false
    await this.config.reload()
    return true
  }

  private async restoreStateFiles(dir: string): Promise<void> {
    const manifest = JSON.parse(await readFile(join(dir, STATE_FILE), 'utf8')) as BookStateManifest
    if (manifest.version !== 1 || !manifest.files) throw new AppError('INTERNAL', 'book state manifest is malformed')
    for (const file of STATE_FILES) {
      const target = join(this.dataDir, file)
      if (manifest.files[file]) await copyFile(join(dir, file), target)
      else await rm(target, { force: true })
    }
  }
}

function requireName(value: string): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (name.length === 0 || name.length > 80) {
    throw new AppError('VALIDATION_ERROR', 'payload.name must be 1-80 non-whitespace characters')
  }
  return name
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    return isObject(parsed) ? parsed : {}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
