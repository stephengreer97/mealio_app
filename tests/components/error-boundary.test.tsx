// A RENDER ERROR MUST NOT BLANK THE APP.
//
// Found in the pre-launch review, 2026-09-16: there was no boundary anywhere --
// not App.tsx, not the navigator, not a screen -- and React unmounts the whole
// tree when nothing catches. One bad render took the user to a blank page with
// no button on it and no way back but the task switcher.
import { render, fireEvent, act } from '@testing-library/react-native';
import React from 'react';
import { Text } from 'react-native';

const mockSubmit = jest.fn(async () => ({ ok: true as const }));
jest.mock('../../src/lib/api', () => ({ bugReport: { submit: (...a: unknown[]) => mockSubmit(...a) } }));
jest.mock('../../src/lib/logBuffer', () => ({ getSessionLogs: () => 'log line one\nlog line two' }));

import ErrorBoundary from '../../src/components/ErrorBoundary';

/** Throws on demand, so a reset can be shown to actually re-render. */
function Boom({ throwNow }: { throwNow: boolean }) {
  if (throwNow) throw new Error('kaboom');
  return <Text>recovered</Text>;
}

/** React logs the caught error; the noise is not the subject of these tests. */
let spy: jest.SpyInstance;
beforeEach(() => { mockSubmit.mockClear(); spy = jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => { spy.mockRestore(); });

describe('when a child throws while rendering', () => {
  it('shows a message instead of nothing at all', () => {
    const v = render(<ErrorBoundary><Boom throwNow /></ErrorBoundary>);
    expect(v.getByTestId('error-boundary')).toBeTruthy();
    expect(v.queryByText(/Something went wrong/i)).toBeTruthy();
  });

  it('renders children untouched when nothing throws', () => {
    // The control: a boundary that always showed its fallback would pass the
    // test above and break the entire app.
    const v = render(<ErrorBoundary><Boom throwNow={false} /></ErrorBoundary>);
    expect(v.queryByTestId('error-boundary')).toBeNull();
    expect(v.queryByText('recovered')).toBeTruthy();
  });

  it('reports the crash, with the logs and the stack', () => {
    render(<ErrorBoundary label="navigator"><Boom throwNow /></ErrorBoundary>);
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    const arg = mockSubmit.mock.calls[0][0] as {
      description: string; logs: string; context: Record<string, unknown>;
    };
    expect(arg.description).toContain('[crash]');
    expect(arg.description).toContain('kaboom');
    expect(arg.logs).toContain('log line one');
    expect(arg.context.kind).toBe('render_error');
    expect(arg.context.boundary).toBe('navigator');
    // The error's own stack, not React's component stack: the test renderer
    // hands componentStack back empty, so asserting on its CONTENT would pin the
    // renderer rather than the reporting. The field is still sent -- a real
    // device fills it -- and the stack below is what identifies the throw.
    expect(typeof arg.context.componentStack).toBe('string');
    expect(String(arg.context.stack)).toContain('Error');
  });

  it('does not crash again when reporting fails', () => {
    // A crash while offline is the likeliest crash there is. The fallback has to
    // render whether or not the report reaches anyone.
    mockSubmit.mockRejectedValueOnce(new Error('offline'));
    const v = render(<ErrorBoundary><Boom throwNow /></ErrorBoundary>);
    expect(v.getByTestId('error-boundary')).toBeTruthy();
  });

  it('offers one reset, and takes it', () => {
    function Flaky() {
      const [n] = React.useState(0);
      return <Boom throwNow={n === 0 && !(global as any).__healed} />;
    }
    (global as any).__healed = false;
    const v = render(<ErrorBoundary><Flaky /></ErrorBoundary>);
    expect(v.getByTestId('error-boundary-retry')).toBeTruthy();
    (global as any).__healed = true;
    act(() => { fireEvent.press(v.getByTestId('error-boundary-retry')); });
    expect(v.queryByTestId('error-boundary')).toBeNull();
    expect(v.queryByText('recovered')).toBeTruthy();
  });

  it('stops offering it once it is clear the reset does not help', () => {
    // A button that has already failed teaches the user it is a lie. After the
    // limit the message says what will actually work.
    const v = render(<ErrorBoundary><Boom throwNow /></ErrorBoundary>);
    act(() => { fireEvent.press(v.getByTestId('error-boundary-retry')); });
    expect(v.queryByTestId('error-boundary-retry')).toBeNull();
    expect(v.queryByText(/Closing and reopening/i)).toBeTruthy();
  });
});
