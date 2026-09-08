// Scores observations against a plan, using the library the tests exercise.
// Two JSON arguments: the plan, then the observations.
import { scoreCanaryRun } from '../src/lib/canary-expectations';
console.log(JSON.stringify(scoreCanaryRun(JSON.parse(process.argv[2]), JSON.parse(process.argv[3]))));
