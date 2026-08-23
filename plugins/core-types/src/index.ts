import { randomUUID } from 'node:crypto'
import {
  definePlugin,
  type BookTagBinding,
  type LedgerPlugin,
  type Tag,
  type TagGroup,
  type TagService,
  type StorageValue,
} from '@ledger/plugin-contract'

interface TagState {
  version: 1
  groups: TagGroup[]
  tags: Tag[]
  /** bookId -> tagId[]；组始终由 tag.groupId 反查，绝不重复存储。 */
  bindings: Record<string, string[]>
}

const STATE_KEY = 'state'
const EMPTY_STATE = (): TagState => ({ version: 1, groups: [], tags: [], bindings: {} })

class TagError extends Error {
  constructor(
    readonly code: 'VALIDATION_ERROR' | 'TAG_GROUP_NOT_FOUND' | 'TAG_GROUP_NAME_TAKEN' | 'TAG_NOT_FOUND' | 'TAG_NAME_TAKEN',
    message: string,
  ) {
    super(message)
    this.name = 'TagError'
  }
}

function requireName(value: string, field: string): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (name.length === 0 || name.length > 80) {
    throw new TagError('VALIDATION_ERROR', `${field} must be 1-80 non-whitespace characters`)
  }
  return name
}

function requireId(value: string, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TagError('VALIDATION_ERROR', `${field} must be a non-empty string`)
  }
  return value
}

/**
 * plugin-core-types 现仅提供标签能力。
 *
 * 标签资料属于项目控制面，通过 Storage Core 的 project 命名空间保存，
 * 因而不会跟随某一次账本切换回退；它们描述并管理账本，而不是账本内容本身。
 */
export const coreTypesPlugin: LedgerPlugin = definePlugin({
  manifest: {
    // 保留既有安装名，已有项目无需迁移 plugins.json。
    name: 'plugin-core-types',
    version: '0.3.0',
    isolation: 'inprocess',
    provides: ['tags'],
  },
  async activate(host) {
    const read = async (): Promise<TagState> => {
      const state = await host.storage.getProject(STATE_KEY) as TagState | undefined
      if (!state) return EMPTY_STATE()
      if (state.version !== 1 || !Array.isArray(state.groups) || !Array.isArray(state.tags) || typeof state.bindings !== 'object') {
        throw new Error('tag project metadata is malformed')
      }
      return structuredClone(state)
    }
    const write = async (state: TagState): Promise<void> => host.storage.setProject(STATE_KEY, state as unknown as StorageValue)
    const findGroup = (state: TagState, id: string): TagGroup => {
      const group = state.groups.find((item) => item.id === requireId(id, 'groupId'))
      if (!group) throw new TagError('TAG_GROUP_NOT_FOUND', `tag group "${id}" not found`)
      return group
    }
    const findTag = (state: TagState, id: string): Tag => {
      const tag = state.tags.find((item) => item.id === requireId(id, 'tagId'))
      if (!tag) throw new TagError('TAG_NOT_FOUND', `tag "${id}" not found`)
      return tag
    }
    const bindingFor = (state: TagState, bookId: string): BookTagBinding => {
      const tagIds = state.bindings[bookId] ?? []
      const tags = tagIds.flatMap((id) => {
        const tag = state.tags.find((item) => item.id === id)
        return tag ? [{ ...tag }] : []
      })
      const groupIds = new Set(tags.map((tag) => tag.groupId))
      return {
        bookId,
        tags,
        groups: state.groups.filter((group) => groupIds.has(group.id)).map((group) => ({ ...group })),
      }
    }
    const assertBook = async (bookId: string): Promise<string> => {
      const id = requireId(bookId, 'bookId')
      await host.books.get(id)
      return id
    }

    const service: TagService = {
      createGroup: async ({ name }) => {
        const state = await read()
        const nextName = requireName(name, 'name')
        if (state.groups.some((group) => group.name === nextName)) {
          throw new TagError('TAG_GROUP_NAME_TAKEN', `tag group name "${nextName}" already exists`)
        }
        const now = Date.now()
        const group: TagGroup = { id: randomUUID(), name: nextName, createdAt: now, updatedAt: now }
        state.groups.push(group)
        await write(state)
        return { ...group }
      },
      getGroup: async (id) => ({ ...findGroup(await read(), id) }),
      listGroups: async () => (await read()).groups.map((group) => ({ ...group })),
      updateGroup: async ({ id, name }) => {
        const state = await read()
        const group = findGroup(state, id)
        const nextName = requireName(name, 'name')
        if (state.groups.some((item) => item.name === nextName && item.id !== group.id)) {
          throw new TagError('TAG_GROUP_NAME_TAKEN', `tag group name "${nextName}" already exists`)
        }
        group.name = nextName
        group.updatedAt = Date.now()
        await write(state)
        return { ...group }
      },
      deleteGroup: async (id) => {
        const state = await read()
        const group = findGroup(state, id)
        const removedTagIds = new Set(state.tags.filter((tag) => tag.groupId === group.id).map((tag) => tag.id))
        state.groups = state.groups.filter((item) => item.id !== group.id)
        state.tags = state.tags.filter((tag) => !removedTagIds.has(tag.id))
        for (const [bookId, tagIds] of Object.entries(state.bindings)) {
          state.bindings[bookId] = tagIds.filter((tagId) => !removedTagIds.has(tagId))
        }
        await write(state)
      },
      createTag: async ({ groupId, name }) => {
        const state = await read()
        const group = findGroup(state, groupId)
        const nextName = requireName(name, 'name')
        if (state.tags.some((tag) => tag.groupId === group.id && tag.name === nextName)) {
          throw new TagError('TAG_NAME_TAKEN', `tag name "${nextName}" already exists in group "${group.id}"`)
        }
        const now = Date.now()
        const tag: Tag = { id: randomUUID(), groupId: group.id, name: nextName, createdAt: now, updatedAt: now }
        state.tags.push(tag)
        await write(state)
        return { ...tag }
      },
      getTag: async (id) => ({ ...findTag(await read(), id) }),
      listTags: async (filter) => {
        const state = await read()
        if (filter?.groupId !== undefined) findGroup(state, filter.groupId)
        return state.tags
          .filter((tag) => filter?.groupId === undefined || tag.groupId === filter.groupId)
          .map((tag) => ({ ...tag }))
      },
      updateTag: async ({ id, groupId, name }) => {
        const state = await read()
        const tag = findTag(state, id)
        if (groupId === undefined && name === undefined) {
          throw new TagError('VALIDATION_ERROR', 'tag update requires name or groupId')
        }
        const targetGroupId = groupId === undefined ? tag.groupId : findGroup(state, groupId).id
        const targetName = name === undefined ? tag.name : requireName(name, 'name')
        if (state.tags.some((item) => item.groupId === targetGroupId && item.name === targetName && item.id !== tag.id)) {
          throw new TagError('TAG_NAME_TAKEN', `tag name "${targetName}" already exists in group "${targetGroupId}"`)
        }
        tag.groupId = targetGroupId
        tag.name = targetName
        tag.updatedAt = Date.now()
        await write(state)
        return { ...tag }
      },
      deleteTag: async (id) => {
        const state = await read()
        const tag = findTag(state, id)
        state.tags = state.tags.filter((item) => item.id !== tag.id)
        for (const [bookId, tagIds] of Object.entries(state.bindings)) {
          state.bindings[bookId] = tagIds.filter((tagId) => tagId !== tag.id)
        }
        await write(state)
      },
      bindBookTags: async ({ bookId, tagIds }) => {
        const id = await assertBook(bookId)
        const state = await read()
        const uniqueTagIds = [...new Set(tagIds.map((tagId) => requireId(tagId, 'tagId')))]
        if (uniqueTagIds.length === 0) throw new TagError('VALIDATION_ERROR', 'tagIds must not be empty')
        uniqueTagIds.forEach((tagId) => findTag(state, tagId))
        state.bindings[id] = [...new Set([...(state.bindings[id] ?? []), ...uniqueTagIds])]
        await write(state)
        return bindingFor(state, id)
      },
      unbindBookTags: async ({ bookId, tagIds }) => {
        const id = await assertBook(bookId)
        const state = await read()
        const remove = new Set(tagIds.map((tagId) => requireId(tagId, 'tagId')))
        if (remove.size === 0) throw new TagError('VALIDATION_ERROR', 'tagIds must not be empty')
        state.bindings[id] = (state.bindings[id] ?? []).filter((tagId) => !remove.has(tagId))
        await write(state)
        return bindingFor(state, id)
      },
      listBookTags: async (bookId) => {
        const id = await assertBook(bookId)
        return bindingFor(await read(), id)
      },
    }
    host.services.provide<TagService>('tags', service)
  },
  async deactivate() {
    // 服务随宿主 cleanupOwner 自动撤销；项目控制面中的标签资料保持可重载。
  },
})
