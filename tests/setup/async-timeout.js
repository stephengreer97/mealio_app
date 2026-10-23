// How long findBy* / waitFor wait before failing, for every component test.
//
// The library default is 1 second, and on CI that was a flake, not a margin.
// The component suite shares a 4-core runner with the cart sheet tests, which
// log thousands of lines and leave timers running after they finish ("a worker
// process has failed to exit gracefully"). That can stall a worker for seconds.
// When it did, deep-link-first-run.test.tsx took 7s instead of about one, and
// a `findByText` whose answer was one render away timed out first, so the
// failure showed a screen that had loaded but not yet drawn the pitch.
//
// Instrumented CI runs put the real wait at 50-110ms, so 5s is a ceiling for a
// stalled worker, not a delay anyone waits through. A test that is genuinely
// broken still fails, just 4 seconds later.
const { configure } = require('@testing-library/react-native');

configure({ asyncUtilTimeout: 5000 });
