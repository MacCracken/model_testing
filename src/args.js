// Shared argument parser for the bench/aggregate/serve CLIs.

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--task":
      case "--tasks": args.task = next(); break;
      case "--mode":
      case "--modes": args.mode = next(); break;
      case "--provider": args.provider = next(); break;
      case "--model": args.model = next(); break;
      case "--clients": args.clients = next(); break;
      case "--count": args.count = Number(next()); break;
      case "--parallel": args.parallel = Number(next()); break;
      case "--instance-seed": args.instanceSeed = Number(next()); break;
      case "--port": args.port = Number(next()); break;
      case "--host": args.host = next(); break;
      case "--open": args.open = true; break;
      case "--json": args.json = true; break;
      case "--no-save": args.noSave = true; break;
      case "--table": args.table = true; break;
      case "--temperature": args.temperature = Number(next()); break;
      case "--seed": args.seed = Number(next()); break;
      case "--model-param": (args.modelParam ??= []).push(next()); break;
      case "--judge": args.judge = next(); break;
      case "--full": args.full = true; break;
      case "--older-than": args.olderThan = Number(next()); break;
      case "--yes": args.yes = true; break;
      case "--sql": args.sql = next(); break;
      case "--limit": args.limit = Number(next()); break;
      case "--q": args.q = next(); break;
      case "--since": args.since = next(); break;
      case "--client": args.client = next(); break;
      case "--a": args.a = next(); break;
      case "--b": args.b = next(); break;
      case "--parent": args.parent = true; break;
      case "--capability": args.capability = next(); break;
      case "--cells": args.cells = true; break;
      case "--out": args.out = next(); break;
      case "--replay": args.replay = next(); break;
      case "--trial": args.trial = Number(next()); break;
      case "--rows": args.rows = true; break;
      case "--jsonl": args.jsonl = true; break;
      case "--all": args.all = true; break;
      case "--gate": (args.gate ??= []).push(next()); break;
      case "--gates": args.gates = next(); break;
      case "--time-box": args.timeBox = Number(next()); break;
      case "--strict": args.strict = true; break;
      case "--min-trials": args.minTrials = Number(next()); break;
      case "--svg": args.svg = next(); break;
      case "--family": args.family = next(); break;
      case "--format": args.format = next(); break;
      case "--webhook": args.webhook = next(); break;
      case "--fail": args.fail = true; break;
      case "--graph": args.graph = true; break;
      default: args._.push(a);
    }
  }
  return args;
}
