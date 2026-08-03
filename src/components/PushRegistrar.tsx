import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import { useAuth } from '../context/AuthContext';
import { navigationRef } from '../navigation/navigationRef';
import {
  addTokenRotationListener,
  configureAndroidChannel,
  routeForNotification,
  supportsRemotePush,
  syncRegistration,
} from '../lib/push';

// ─────────────────────────────────────────────────────────────────────────────
// PushRegistrar
//
// Renders nothing. Owns the two things that have to happen once per app run and
// cannot live in a screen: keeping the server's copy of this device's push
// token current, and turning a notification tap into a navigation.
//
// It never asks for permission — see src/lib/push.ts. syncRegistration() is a
// no-op unless the user already granted it, so mounting this at the root costs
// nothing for the users who said no.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Whether `target` is a route the navigator would actually accept right now.
 *
 * isReady() is necessary and not sufficient. Tabs are conditional on state that
 * arrives after the container mounts — the Creator tab only exists once
 * AuthContext's checkCreatorStatus() round trip resolves (MainTabs.tsx) — so on
 * a cold start isReady() flips true while `Creator` is still missing, and a
 * navigate() to it is dropped with no error. That is the common case for a
 * notification tap and it is the payload type this whole feature exists for.
 *
 * Searches nested navigators: the tabs live inside RootNavigator's stack.
 */
function canNavigateTo(state: any, target: string): boolean {
  if (!state) return false;
  if (Array.isArray(state.routeNames) && state.routeNames.includes(target)) return true;
  return (state.routes ?? []).some((r: any) => canNavigateTo(r.state, target));
}

/**
 * ~6s of frames. Long enough to cover a cold start plus the creator-status
 * request that decides whether the Creator tab exists at all; past that the tab
 * is genuinely not coming, and silently leaving the user on the default screen
 * beats both looping and a navigate() that goes nowhere.
 */
const ROUTE_WAIT_ATTEMPTS = 120;

/**
 * Sends the tap somewhere sensible. A cold start can run this before the
 * navigator exists — and before the target tab exists — so it retries on the
 * next frame until the destination is actually reachable.
 */
function openFromNotification(data: unknown, attempt = 0): void {
  const route = routeForNotification(data);
  if (!route) return;

  if (!navigationRef.isReady() || !canNavigateTo(navigationRef.getRootState(), route.target)) {
    if (attempt < ROUTE_WAIT_ATTEMPTS) setTimeout(() => openFromNotification(data, attempt + 1), 50);
    return;
  }

  // A `creator_draft` tap carries params that open the review queue on arrival
  // (MEAL-89), rather than merely landing on the Creator tab and leaving the
  // creator to find the thing the notification was about. Every other type
  // navigates bare, as before.
  //
  // Cast because navigationRef is typed to MainTabsParamList, whose `Creator`
  // entry is the only one that takes params; `navigate(name, params)` has no
  // overload that accepts a union of a param-less and a param-taking route.
  (navigationRef.navigate as (name: string, params?: object) => void)(route.target, route.params);
}

export default function PushRegistrar() {
  const { user } = useAuth();
  const handled = useRef<string | null>(null);

  // Refresh the stored token whenever a user is present — on launch and again
  // after a sign-in, since a token registered by a previous account belongs to
  // that account's row until this one claims it.
  useEffect(() => {
    if (!user) return;
    void configureAndroidChannel();
    void syncRegistration();
  }, [user?.id]);

  useEffect(() => {
    if (!supportsRemotePush()) return;
    const sub = addTokenRotationListener();
    return () => sub.remove();
  }, []);

  useEffect(() => {
    // Cold start: the tap that launched the app is not delivered to the listener.
    Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        if (!response) return;
        // Guard against re-handling the same launch response on a remount —
        // Expo keeps returning it for the lifetime of the process.
        const id = response.notification.request.identifier;
        if (handled.current === id) return;
        handled.current = id;
        openFromNotification(response.notification.request.content.data);
      })
      .catch(() => {});

    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      openFromNotification(response.notification.request.content.data);
    });
    return () => sub.remove();
  }, []);

  return null;
}
