// Prints the expectation plan for one store's CANARY MEAL.
//
// A FILE RATHER THAN AN INLINE `tsx -e`. The inline form needs the argument
// embedded in a shell string inside a JS string, and the quoting broke the first
// time a real plan went through it. This takes one JSON argument.
//
// The MEAL is the source, not an admin text box: Stephen curates a canary's
// branches by editing the saved meal, so the plan has to be read from the same
// place. Keyed on the chosen PRODUCT, because that is what a run reports.
import { buildPlanFromMeal } from '../src/lib/canary-expectations';

const arg = JSON.parse(process.argv[2]);
console.log(JSON.stringify(
  buildPlanFromMeal(arg.storeId, arg.mealName, arg.lines || []),
));
