import { Effect, Layer, ServiceMap } from "effect"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { InstanceState } from "@/effect/instance-state"
import { makeRunPromise } from "@/effect/run-service"
import { FileWatcher } from "@/file/watcher"
import { Git } from "@/git"
import { Snapshot } from "@/snapshot"
import { Log } from "@/util/log"
import { git } from "@/util/git"
import path from "path"
import { Instance } from "./instance"
import z from "zod"

export namespace Vcs {
  const log = Log.create({ service: "vcs" })
  const count = (text: string) => {
    if (!text) return 0
    if (!text.endsWith("\n")) return text.split("\n").length
    return text.slice(0, -1).split("\n").length
  }

  const work = async (cwd: string, file: string) => {
    const full = path.join(cwd, file)
    const next = Bun.file(full)
    if (!(await next.exists())) return ""
    const text = await next.text().catch(() => "")
    if (text.includes("\u0000")) return ""
    return text
  }

  const nums = (list: Git.Stat[]) => {
    return new Map(list.map((item) => [item.file, item] as const))
  }

  const merge = (...list: Git.Item[][]) => {
    const out = new Map<string, Git.Item>()
    list.flat().forEach((item) => {
      if (out.has(item.file)) return
      out.set(item.file, item)
    })
    return [...out.values()]
  }

  const CONCURRENCY = 8

  const files = async (cwd: string, ref: string | undefined, list: Git.Item[], map: Map<string, Git.Stat>, root: string) => {
    const results: Snapshot.FileDiff[] = []
    for (let i = 0; i < list.length; i += CONCURRENCY) {
      const batch = list.slice(i, i + CONCURRENCY)
      const chunk = await Promise.all(
        batch.map(async (item) => {
          const before = item.status === "added" || !ref ? "" : await Git.show(cwd, ref, item.file, root)
          const after = item.status === "deleted" ? "" : await work(cwd, item.file)
          const stat = map.get(item.file)
          return {
            file: item.file,
            before,
            after,
            additions: stat?.additions ?? (item.status === "added" ? count(after) : 0),
            deletions: stat?.deletions ?? (item.status === "deleted" ? count(before) : 0),
            status: item.status,
          } satisfies Snapshot.FileDiff
        }),
      )
      results.push(...chunk)
    }
    return results.toSorted((a, b) => a.file.localeCompare(b.file))
  }

  export const Mode = z.enum(["git", "branch"])
  export type Mode = z.infer<typeof Mode>

  export const Event = {
    BranchUpdated: BusEvent.define(
      "vcs.branch.updated",
      z.object({
        branch: z.string().optional(),
      }),
    ),
  }

  export const Info = z
    .object({
      branch: z.string(),
      default_branch: z.string().optional(),
    })
    .meta({
      ref: "VcsInfo",
    })
  export type Info = z.infer<typeof Info>

  export interface Interface {
    readonly init: () => Effect.Effect<void>
    readonly branch: () => Effect.Effect<string | undefined>
  }

  interface State {
    current: string | undefined
  }

  export class Service extends ServiceMap.Service<Service, Interface>()("@opencode/Vcs") {}

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const state = yield* InstanceState.make<State>(
        Effect.fn("Vcs.state")((ctx) =>
          Effect.gen(function* () {
            if (ctx.project.vcs !== "git") {
              return { current: undefined }
            }

            const getCurrentBranch = async () => {
              const result = await git(["rev-parse", "--abbrev-ref", "HEAD"], {
                cwd: ctx.worktree,
              })
              if (result.exitCode !== 0) return undefined
              const text = result.text().trim()
              return text || undefined
            }

            const value = {
              current: yield* Effect.promise(() => getCurrentBranch()),
            }
            log.info("initialized", { branch: value.current })

            yield* Effect.acquireRelease(
              Effect.sync(() =>
                Bus.subscribe(
                  FileWatcher.Event.Updated,
                  Instance.bind(async (evt) => {
                    if (!evt.properties.file.endsWith("HEAD")) return
                    const next = await getCurrentBranch()
                    if (next !== value.current) {
                      log.info("branch changed", { from: value.current, to: next })
                      value.current = next
                      Bus.publish(Event.BranchUpdated, { branch: next })
                    }
                  }),
                ),
              ),
              (unsubscribe) => Effect.sync(unsubscribe),
            )

            return value
          }),
        ),
      )

      return Service.of({
        init: Effect.fn("Vcs.init")(function* () {
          yield* InstanceState.get(state)
        }),
        branch: Effect.fn("Vcs.branch")(function* () {
          return yield* InstanceState.use(state, (x) => x.current)
        }),
      })
    }),
  )

  const runPromise = makeRunPromise(Service, layer)

  export function init() {
    return runPromise((svc) => svc.init())
  }

  export function branch() {
    return runPromise((svc) => svc.branch())
  }

  export async function defaultBranch() {
    if (Instance.project.vcs !== "git") return undefined
    return Git.defaultBranch(Instance.directory).then((b) => b?.name)
  }

  export async function diff(mode: Mode): Promise<Snapshot.FileDiff[]> {
    if (Instance.project.vcs !== "git") return []
    const cwd = Instance.directory
    if (mode === "git") {
      const has = await Git.hasHead(cwd)
      const list = await Git.status(cwd)
      if (!has) return files(cwd, undefined, list, new Map(), "")
      const [stats, root] = await Promise.all([Git.stats(cwd, "HEAD"), Git.prefix(cwd)])
      return files(cwd, "HEAD", list, nums(stats), root)
    }

    const base = await Git.defaultBranch(cwd)
    if (!base) return []
    const head = await Git.branch(cwd)
    if (head && head === base.name) return []
    const ref = await Git.mergeBase(cwd, base.ref)
    if (!ref) return []

    const [list, stats, seen, root] = await Promise.all([Git.diff(cwd, ref), Git.stats(cwd, ref), Git.status(cwd), Git.prefix(cwd)])
    return files(
      cwd,
      ref,
      merge(
        list,
        seen.filter((item) => item.code === "??"),
      ),
      nums(stats),
      root,
    )
  }
}
