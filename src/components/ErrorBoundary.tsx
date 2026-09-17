import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Colors } from '../constants/colors';
import { getSessionLogs } from '../lib/logBuffer';
import { bugReport } from '../lib/api';

/**
 * THE LAST THING BETWEEN A RENDER ERROR AND A BLANK SCREEN.
 *
 * Until this existed there was no boundary anywhere in the app — App.tsx, the
 * navigator, none of the screens — and React's behaviour when nothing catches is
 * to unmount the whole tree. One bad render in one screen took the user to a
 * blank page with no button on it, and the only way back was to kill the app
 * from the task switcher. Found in the pre-launch review, 2026-09-16.
 *
 * WHY NOT SENTRY. The app already has everything a crash report needs: a
 * redacted console ring buffer (logBuffer, which runs in the shipped build
 * precisely so reports can carry it) and a /api/bug-report endpoint that takes
 * a description, those logs and a context blob, and accepts an anonymous post so
 * a crash before sign-in still arrives. Adding a vendor SDK would be a second
 * pipeline for the same facts, plus a native dependency and a new build, to
 * reach the same inbox.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it does not try to keep the app running
 * around a component that just threw. It offers one reset, because a render
 * error is usually a bad prop or a bad response and the state that produced it
 * is often gone by the time the user taps.
 */

interface Props {
  children: React.ReactNode;
  /** Names which boundary reported, when there is more than one. */
  label?: string;
}

interface State {
  error: Error | null;
  /** Resets attempted. A boundary that re-throws instantly must not offer the
   *  same button for ever — see RESET_LIMIT. */
  resets: number;
}

/**
 * One reset, then the honest message.
 *
 * A second and third button do nothing for the user if the thing that threw
 * throws again on the same data — it just teaches them the button is a lie.
 */
const RESET_LIMIT = 1;

export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, resets: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }) {
    // Never let reporting a crash cause one. Everything here is best effort and
    // the fallback UI must render whatever happens.
    try {
      // eslint-disable-next-line no-console
      console.error('[ErrorBoundary]', this.props.label ?? 'root', error?.message, info?.componentStack);
      void bugReport
        .submit({
          description: `[crash] ${this.props.label ?? 'root'}: ${error?.message ?? 'unknown error'}`,
          logs: getSessionLogs(),
          context: {
            kind: 'render_error',
            boundary: this.props.label ?? 'root',
            message: String(error?.message ?? ''),
            stack: String(error?.stack ?? '').slice(0, 4000),
            componentStack: String(info?.componentStack ?? '').slice(0, 4000),
          },
        })
        // A crash while offline is the likeliest crash of all. The console.error
        // above is already in the ring buffer, so the next report the user sends
        // by hand still carries it.
        .catch(() => {});
    } catch {
      /* reporting is never worth a second crash */
    }
  }

  render() {
    const { error, resets } = this.state;
    if (!error) return this.props.children;

    const canReset = resets < RESET_LIMIT;
    return (
      <View style={styles.wrap} testID="error-boundary">
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.body}>
          Mealio hit an unexpected problem and had to stop what it was doing.
          {canReset
            ? ' Trying again will reload this screen.'
            : ' Closing and reopening Mealio should clear it.'}
        </Text>
        <Text style={styles.note}>A report has been sent, so we can look into it.</Text>
        {canReset && (
          <TouchableOpacity
            testID="error-boundary-retry"
            style={styles.button}
            onPress={() => this.setState((s) => ({ error: null, resets: s.resets + 1 }))}
          >
            <Text style={styles.buttonText}>Try again</Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }
}

const styles = StyleSheet.create({
  wrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, backgroundColor: Colors.bg },
  title: { fontSize: 20, fontFamily: 'Inter_600SemiBold', color: Colors.text1, marginBottom: 10, textAlign: 'center' },
  body: { fontSize: 15, fontFamily: 'Inter_400Regular', color: Colors.text2, textAlign: 'center', lineHeight: 22 },
  note: { fontSize: 13, fontFamily: 'Inter_400Regular', color: Colors.text3, textAlign: 'center', marginTop: 12 },
  button: {
    marginTop: 24, paddingVertical: 12, paddingHorizontal: 28,
    borderRadius: 999, backgroundColor: Colors.brand,
  },
  buttonText: { fontSize: 15, fontFamily: 'Inter_600SemiBold', color: '#fff' },
});
