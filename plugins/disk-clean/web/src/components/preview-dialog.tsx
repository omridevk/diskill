import {Check, Copy} from 'lucide-react'
import {useState} from 'react'
import {Badge} from '@/components/ui/badge'
import {Button} from '@/components/ui/button'
import {Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle} from '@/components/ui/dialog'
import {Tabs, TabsContent, TabsList, TabsTrigger} from '@/components/ui/tabs'
import {formatBytes} from '@/lib/data'

export interface Plan {
  commands: string[]
  rejected: {reason: string; path: string}[]
  count: number
  bytes: number
}

const VERB = /^(rm -rf --|git -C \S+ worktree (?:remove|prune)|#[^:]*:)\s?(.*)$/

function Line({n, text}: {n: number; text: string}) {
  const [, verb = text, rest = ''] = text.match(VERB) ?? []
  const color = verb.startsWith('rm') ? 'text-red-400' : verb.startsWith('#') ? 'text-muted-foreground' : 'text-blue-300'
  return (
    <div className="grid grid-cols-[44px_minmax(0,1fr)] gap-3 pr-4">
      <span className="text-right text-zinc-600 select-none">{n}</span>
      <span className="break-all">
        <span className={color}>{verb}</span> <span className="text-zinc-200">{rest}</span>
      </span>
    </div>
  )
}

function Lines({lines}: {lines: string[]}) {
  return (
    <div className="max-h-[46vh] overflow-auto rounded-lg border bg-background py-3 font-mono text-[12.5px] leading-relaxed">
      {lines.map((line, i) => (
        <Line key={i} n={i + 1} text={line} />
      ))}
    </div>
  )
}

function stats(plan: Plan) {
  const count = (re: RegExp) => plan.commands.filter(c => re.test(c)).length
  return [
    {n: count(/^rm /), label: 'folders deleted'},
    {n: count(/ worktree remove /), label: 'worktrees removed'},
    {n: count(/ worktree prune$/), label: 'repos pruned'},
    {n: count(/^(xcrun|docker|brew) /), label: 'fixed commands'},
  ]
}

export function PreviewDialog({plan, open, onOpenChange, onApprove}: {plan: Plan | null; open: boolean; onOpenChange: (open: boolean) => void; onApprove: () => void}) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    if (!plan) return
    navigator.clipboard.writeText(`#!/bin/sh\nset -e\n${plan.commands.join('\n')}\n`).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2.5">
            Dry run <Badge className="bg-emerald-500/15 text-emerald-300">nothing has run</Badge>
          </DialogTitle>
          <DialogDescription>
            Approve runs exactly these commands, four at a time, largest first. Deletion is permanent, not to the Trash.
            Each worktree is re-checked right before removal; git refuses any that changed.
          </DialogDescription>
        </DialogHeader>
        {plan && (
          <>
            <div className="grid grid-cols-4 gap-2">
              {stats(plan).map(s => (
                <div key={s.label} className="flex flex-col rounded-lg border px-3 py-2">
                  <span className="text-xl font-semibold tabular-nums">{s.n}</span>
                  <span className="text-xs text-muted-foreground">{s.label}</span>
                </div>
              ))}
            </div>
            <Tabs defaultValue="commands">
              <div className="flex items-center">
                <TabsList variant="line">
                  <TabsTrigger value="commands">Commands {plan.commands.length}</TabsTrigger>
                  <TabsTrigger value="rejected">Rejected {plan.rejected.length}</TabsTrigger>
                </TabsList>
                <span className="grow" />
                <Button variant="outline" size="sm" onClick={copy}>
                  <span className="t-icon-swap" data-state={copied ? 'b' : 'a'}>
                    <Copy className="t-icon" data-icon="a" />
                    <Check className="t-icon" data-icon="b" />
                  </span>
                  {copied ? 'Copied' : 'Copy as shell script'}
                </Button>
              </div>
              <TabsContent value="commands">
                <Lines lines={plan.commands} />
              </TabsContent>
              <TabsContent value="rejected">
                {plan.rejected.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">Every selected item passed the safety checks.</p>
                ) : (
                  <Lines lines={plan.rejected.map(r => `# ${r.reason}: ${r.path}`)} />
                )}
              </TabsContent>
            </Tabs>
          </>
        )}
        <DialogFooter className="items-center">
          <span className="grow text-xs text-muted-foreground">
            Same list in the terminal: <code className="font-mono text-zinc-300">disk-clean clean --dry-run</code>
          </span>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Back to selection
          </Button>
          <Button className="bg-red-600 text-white hover:bg-red-600/90" disabled={!plan || plan.count === 0} onClick={onApprove}>
            Approve and delete {plan ? formatBytes(plan.bytes) : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
