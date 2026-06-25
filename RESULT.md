# RESULT

Summary:
- Focused fake-sacrifice precision pass completed.
- No commit or push performed.

Files changed:
- src/stockfishAnalyzer.js
- scripts/diagnose-brilliant-move.js
- RESULT.md

Commands run:
- node --check src/stockfishAnalyzer.js
- node --check scripts/diagnose-brilliant-move.js
- git diff --check
- targeted diagnose-brilliant commands for benchmark controls

Verification:
- Syntax checks passed for edited JavaScript files.
- git diff --check passed.

First-benchmark accepted controls:
- 15...fxe4: accepted
- 17.Rxf6: accepted
- 9...Bxh2+: accepted
- 26.Bxh6: accepted
- 12...Nxf2: accepted
- 11.Bxh6: accepted
- 21...Ng4+: accepted

First-benchmark rejected controls:
- 13.Bxg7: rejected
- 9.Nxc7+: rejected
- 17.Bxh6: rejected
- 9...Nxf2: rejected
- 22...Qe3: rejected
- 16.Bxh6: rejected

Second-slice accepted controls:
- 14.Bxh6: accepted
- 19.Rxb6+: accepted
- 11...Bxa3: accepted
- 18...Nxg2: accepted
- 26.Rxd6: accepted
- 20...Bxg3: accepted
- 20.Rxf6+: accepted

Second-slice rejected controls:
- 8.Bxh6: rejected
- 10.Ng5: rejected
- 20.Be3+: rejected
- 21.Bf4+: rejected
- 22.Be3+: rejected
- 17...Bxg2+: rejected

Batch results:
- Existing source report had errors=0.
- Fresh batch command timed out in MCP before output.

Limitations:
- Used --ply for black-move diagnostics because MCP blocks ellipsis move labels.
- Full batch validation still needs a longer local shell.

Follow-up:
- Review diff and run full batch validation before committing.

Validation excerpts:
- 8.Bxh6: Rejection reason: under-defended pawn win with protected bishop, not a true sacrifice.
- 10.Ng5: Rejection reason: protected tactical knight threat is not a true material concession.
- 20.Be3+, 21.Bf4+, 22.Be3+: Rejection reason: no real material concession behind the checking tactic.
- 17...Bxg2+: Rejection reason: checking bishop pawn capture looks like already-doomed-material desperado.
- 9...Bxh2+ and 20...Bxg3 remained accepted after the desperado gate.
- git status after batch timeout showed no tracked data changes.

Local batch validation completed:
- data/reports/pgn-batch-witty_alien-20260607T234148454Z.json
  - analyzedGames: 50
  - gamesWithLocalCandidates: 7
  - localCandidateMoves: 7
  - errors: 0
- data/reports/pgn-batch-witty_alien-20260607T234852375Z.json
  - analyzedGames: 50
  - gamesWithLocalCandidates: 7
  - localCandidateMoves: 7
  - errors: 0

Report inspection notes:
- First batch preserved known true controls present in the slice: 15...fxe4, 17.Rxf6, 9...Bxh2+, 26.Bxh6, 12...Nxf2, 11.Bxh6, 21...Ng4+.
- First batch kept known false controls present in the slice rejected: 9.Nxc7+, 17.Bxh6, 9...Nxf2, 22...Qe3, 16.Bxh6. 13.Bxg7 was validated by targeted diagnostic.
- Second batch preserved known true controls present in the slice: 14.Bxh6, 19.Rxb6+, 11...Bxa3, 18...Nxg2, 26.Rxd6, 20...Bxg3, 20.Rxf6+.
- Second batch kept second-slice false positives rejected: 8.Bxh6, 10.Ng5, 20.Be3+, 21.Bf4+, 22.Be3+, 17...Bxg2+ all had no local candidates in their games.
- Candidate count did not collapse: the second validated 50-game slice went from the previous 10 candidate games / 13 moves summary to 7 candidate games / 7 moves, consistent with removing the six targeted false positives.
- Final git status after local batch validation still showed no tracked data/report changes.

Validation excerpts:
- 8.Bxh6: Rejection reason: under-defended pawn win with protected bishop, not a true sacrifice.
- 10.Ng5: Rejection reason: protected tactical knight threat is not a true material concession.
- 20.Be3+, 21.Bf4+, 22.Be3+: Rejection reason: no real material concession behind the checking tactic.
- 17...Bxg2+: Rejection reason: checking bishop pawn capture looks like already-doomed-material desperado.
- 9...Bxh2+ and 20...Bxg3 remained accepted after the desperado gate.
- git status after batch timeout showed no tracked data changes.
