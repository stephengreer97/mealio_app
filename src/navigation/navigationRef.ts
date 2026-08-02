import { createNavigationContainerRef } from '@react-navigation/native';
import type { MainTabsParamList } from './MainTabs';

/**
 * Navigation handle for callers that live outside the tree — today just the
 * push notification tap handler (MEAL-88), which has to navigate from an OS
 * callback that can fire before any screen has mounted.
 *
 * Always guard on isReady(): a cold start from a notification runs the handler
 * while the container is still mounting, and navigate() would be dropped.
 */
export const navigationRef = createNavigationContainerRef<MainTabsParamList>();
