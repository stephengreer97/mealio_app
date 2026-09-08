// Prints the expectation plan for one store's admin-typed config.
//
// A FILE RATHER THAN AN INLINE `tsx -e`. The inline form needs the config
// embedded in a shell string inside a JS string, and the quoting broke the first
// time a real plan went through it. This takes one JSON argument.
import { buildPlanFromConfig } from '../src/lib/canary-expectations';
console.log(JSON.stringify(buildPlanFromConfig(JSON.parse(process.argv[2]))));
