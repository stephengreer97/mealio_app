#!/usr/bin/env bash
# PostToolUse(Bash) hook for `git push`. DOES NOTHING, ON PURPOSE.
#
# WHY THIS IS EMPTY (2026-08-31).
#
# It used to poll GitHub Actions until every run on the pushed commit finished —
# bounded at ~50 minutes to accommodate the iOS job — and then exit 2 so the
# harness woke the agent with the result. Registered with asyncRewake, that made
# CI a STOP CONDITION: after any push, an agent could not finish its turn until
# the runs completed. It did not merely inform; it held.
#
# What that cost, in one afternoon:
#   - agents sat on finished work for tens of minutes, unable to write the ticket
#     up or hand off, while a green build they did not need crawled through a
#     queue. Stephen asked four times why an agent was "still waiting on CI".
#   - every fresh push cancelled the previous run by concurrency group, so the
#     wait restarted, and the hook then reported that CANCELLED run as a failure
#     ("1 run(s) failed... fix, and push again") — for a commit that had merely
#     been superseded. Twice that sent an agent looking for a bug that did not
#     exist.
#   - it inverted the priority: the ledger is what Stephen reads, and it was the
#     thing being delayed, by a signal he reviews himself anyway.
#
# "I don't want the AI to wait until CI is done to comment and finish in the
# mealio tracker. I can review CI myself."
#
# So: push, then write the ticket, then hand off. CI results are Stephen's to
# read. If a run genuinely fails, that is a follow-up conversation, not a reason
# to have held the work.
#
# IF YOU EVER RESTORE POLLING, the design constraint is that it must not be able
# to block a stop: report asynchronously without exit 2, ignore runs whose SHA is
# no longer the branch tip (those are superseded, not failed), and never let the
# bound exceed a few seconds. The previous version is in git history.
exit 0
