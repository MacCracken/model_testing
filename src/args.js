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
      case "--cells": args.cells = true; break;
      case "--out": args.out = next(); break;
      default: args._.push(a);
    }
  }
  return args;
}
