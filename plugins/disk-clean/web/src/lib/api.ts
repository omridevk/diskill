import type {Plan} from '@/components/preview-dialog'
import type {Item} from './data'

const body = (token: string, items: readonly Item[], extra: object) =>
  JSON.stringify({token, items: items.map(i => ({path: i.path})), ...extra})

async function post(url: string, payload: string) {
  const response = await fetch(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: payload})
  if (!response.ok) throw new Error(`${url} failed: ${response.status}`)
  return response.json()
}

export function preview(token: string, items: readonly Item[]): Promise<Plan> {
  return post('/preview', body(token, items, {}))
}

export function decide(token: string, decision: 'approve' | 'cancel', items: readonly Item[]) {
  return post('/decide', body(token, decision === 'approve' ? items : [], {decision}))
}
