#!/bin/bash
# A fake `claude` for the real-user CI step, installed root-owned. It reports
# who ran it, whether that user could write into and list the home named after
# `PROBE:` in the prompt, and the names (never the values) of its env.
if [ "$1" = "--version" ]; then echo '2.1.305 (Claude Code)'; exit 0; fi
prompt=$(cat)
# `SLEEP:<path>`: a judge still running at the deadline. exec keeps the pid, so a signal to it reaches the sleeper.
case "$prompt" in SLEEP:*) echo $$ > "${prompt#SLEEP:}"; exec sleep 60 ;; esac
home=${prompt#*PROBE:}
home=${home%%[[:space:]]*}
if touch "$home/judge-was-here" 2>/dev/null; then write=ok; else write=denied; fi
if ls "$home" >/dev/null 2>&1; then read=ok; else read=denied; fi
names=$(env | cut -d= -f1 | sort | paste -sd, -)
printf '{"type":"result","subtype":"success","is_error":false,"result":"user=%s;write=%s;read=%s;env=%s","total_cost_usd":0,"modelUsage":{"claude-opus-5":{}}}\n' \
  "$(id -un)" "$write" "$read" "$names"
