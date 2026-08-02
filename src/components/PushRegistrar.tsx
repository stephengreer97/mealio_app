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
 * Sends the tap somewhere sensible. A cold start can run this before the
 * navigator exists, so it retries on the next frame until the container is
 * ready rather than dropping the navigation.
 */
function openFromNotification(data: unknown, attempt = 0): void {
  const route = routeForNotification(data);
  if (!route) return;

  if (!navigationRef.isReady()) {
    // ~2s of frames. Beyond that the app is wedged for other reasons and
    // silently landing on the default screen is better than looping.
    if (attempt < 40) setTimeout(() => openFromNotification(data, attempt + 1), 50);
    return;
  }

  // MEAL-89 SEAM: `route.draftId` is carried but has nowhere to go until the
  // review-queue screen exists. When it does, navigate to it here instead of
  // the tab, and nothing on the server or in the payload has to change.
  navigationRef.navigate(route.target);
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
