import type { EntryData } from './entry.js'

export interface EntryEventContext {
  source: string
  recorder: string
}

export interface EntryRecordedEvent {
  kind: 'EntryRecorded'
  entry: EntryData
  context: EntryEventContext
}

export interface EntryRevisedEvent {
  kind: 'EntryRevised'
  entry: EntryData
  before: EntryData
  context: EntryEventContext
}

export interface EntryVoidedEvent {
  kind: 'EntryVoided'
  entry: EntryData
  context: EntryEventContext
}

export type LedgerDomainEvent = EntryRecordedEvent | EntryRevisedEvent | EntryVoidedEvent

export type LedgerEventName = LedgerDomainEvent['kind']
