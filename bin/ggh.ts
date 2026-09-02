#!/usr/bin/env bun
import { runCli } from "../src/index.ts";

runCli(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
