// Mealio app test runner — two-project layout.
//
//   • node project (ts-jest):
//       - tests/unit/**           pure-function unit tests
//       - tests/fixture-tests/**  fixture HTML loaded into headless Chromium
//                                 via Playwright-as-library
//       - tests/live/**           (gated) real-store live tests
//   • component project (jest-expo):
//       - tests/components/**     React Native component tests via @testing-
//                                 library/react-native against the actual
//                                 Expo runtime
//
// Run all: `npm test`.  Run one flavor: `npm run test:unit` etc.
// Run a single project directly: `npx jest --selectProjects node`.

const isLive = !!process.env.MEALIO_RUN_LIVE_TESTS;

/** @type {import('jest').Config} */
module.exports = {
  testTimeout: isLive ? 180_000 : 30_000,
  projects: [
    {
      displayName: 'node',
      preset: 'ts-jest',
      testEnvironment: 'node',
      rootDir: '.',
      testMatch: [
        '<rootDir>/tests/unit/**/*.test.ts',
        '<rootDir>/tests/fixture-tests/**/*.spec.ts',
        '<rootDir>/tests/fixture-runners/**/*.test.ts',
        '<rootDir>/tests/live/**/*.spec.ts',
      ],
      testPathIgnorePatterns: isLive
        ? ['<rootDir>/node_modules/']
        : ['<rootDir>/node_modules/', '<rootDir>/tests/live/'],
      transformIgnorePatterns: ['/node_modules/'],
    },
    {
      displayName: 'components',
      preset: 'jest-expo',
      rootDir: '.',
      testMatch: ['<rootDir>/tests/components/**/*.test.tsx', '<rootDir>/tests/components/**/*.test.ts'],
      // jest-expo configures its own transformer for RN modules; we don't
      // need to widen transformIgnorePatterns further here unless we hit a
      // module that needs special treatment.
    },
  ],
};
