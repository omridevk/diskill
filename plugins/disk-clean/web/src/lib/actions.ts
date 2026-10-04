import {createOptimisticAction} from '@tanstack/db'
import {decide, heldAction, messageOf, rescan as requestRescan} from './api'
import {openCleanup, openScan, writeSession, type Action, type Db, type Planned} from './db'
import {RESTART, type Entry} from './scan-feed'

const plannedOf = ({path, label, bytes, section, exact}: Entry): Planned => ({path, label, bytes, section, exact})

function markPending(db: Db, action: Action) {
  const requests = db.requests.collection
  if (requests.has(action)) {
    requests.update(action, draft => {
      draft.status = 'pending'
      draft.message = ''
    })
    return
  }
  requests.insert({id: action, status: 'pending', message: ''})
}

function tracked(db: Db, action: Action, apply: () => void, send: () => Promise<void>) {
  const run = createOptimisticAction<null>({
    onMutate: () => {
      markPending(db, action)
      apply()
    },
    mutationFn: async () => {
      await send()
      db.requests.write(writes => writes.remove(action))
    },
  })
  return run(null)
    .when('settled')
    .then(
      () => undefined,
      (e: unknown) => db.requests.write(writes => writes.put({id: action, status: 'failed', message: messageOf(e)})),
    )
}

function stopScan(db: Db) {
  const scan = db.scan.scan.synced.get('scan')
  if (!scan || scan.done || scan.error !== '') return false
  db.streams.scan?.()
  db.streams.scan = null
  db.scan.scan.collection.update('scan', draft => {
    draft.stopped = true
  })
  return true
}

export function approve(db: Db, items: readonly Entry[], approvedBytes: number) {
  const rows = items.map(plannedOf)
  const stopped = {scan: false}
  const apply = () => {
    db.plan.collection.insert(rows)
    db.session.collection.update('session', draft => {
      draft.approved = true
      draft.approvedBytes = approvedBytes
    })
    stopped.scan = stopScan(db)
  }
  return tracked(db, 'approve', apply, async () => {
    try {
      await decide(db.loaded.token, 'approve', items)
    } catch (e) {
      if (stopped.scan) openScan(db)
      throw e
    }
    const scan = db.scan.scan.synced.get('scan')
    if (stopped.scan && scan) db.scan.scan.write(writes => writes.put({...scan, stopped: true}))
    db.plan.write(writes => rows.forEach(writes.put))
    writeSession(db, {approved: true, approvedBytes})
    openCleanup(db)
  })
}

export function cancel(db: Db) {
  return tracked(
    db,
    'cancel',
    () => {},
    async () => {
      await decide(db.loaded.token, 'cancel', [])
      writeSession(db, {cancelled: true})
    },
  )
}

export function askHeld(db: Db, action: 'undo' | 'free') {
  return tracked(
    db,
    action,
    () => {},
    async () => {
      await heldAction(db.loaded.token, action)
    },
  )
}

function restarted(db: Db) {
  return new Promise<void>(resolve => db.scan.restarts.add(resolve))
}

function restartOptimistically(db: Db) {
  db.scan.scan.collection.update('scan', draft => {
    Object.assign(draft, {...RESTART, rescans: draft.rescans + 1})
  })
  db.scan.progress.collection.update('progress', draft => Object.assign(draft, {files: 0, bytes: 0, dir: ''}))
}

export function restartScan(db: Db) {
  return tracked(
    db,
    'rescan',
    () => restartOptimistically(db),
    async () => {
      await requestRescan(db.loaded.token)
      const confirmed = restarted(db)
      openScan(db)
      await confirmed
    },
  )
}
