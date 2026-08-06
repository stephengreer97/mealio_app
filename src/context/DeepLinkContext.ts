import { createContext, useContext } from 'react';

// Is a deep link currently owning the screen? (MEAL-84)
//
// `RootNavigator` renders its deep-link sheets — the shared-meal screen and the
// preset `MealDetailSheet` — as *siblings* of the whole app, so nothing rendered
// inside the tabs can see them. That is fine until something inside the tabs
// wants to open a Modal of its own, because two RN Modals on screen at once
// block touch events on iOS: the 300ms close-first dance in `handleDeepLink` is
// there because that bug was already paid for once, and it de-conflicts the
// preset sheet against itself only.
//
// The first-run welcome is exactly such a Modal, and its trigger races the deep
// link with no ordering between them. Cold-open `mealio://meal/p/<id>` on a
// fresh install: `getInitialURL` resolves and fetches the meal while
// DiscoverScreen independently finishes its first load and pops the pitch. A
// user arriving from a shared link — the highest-intent way anyone ever meets
// this app — could end up able to dismiss neither sheet on their first launch.
//
// So the welcome asks first. It is an explainer, not a route: holding it until
// the link's sheet closes costs nothing, and it is not lost, because the
// shown-once flag is only spent when it is actually dismissed.
//
// Default `false` — a DiscoverScreen rendered without a provider (tests, and
// any future host) behaves exactly as it did before this existed.
export const DeepLinkBusyContext = createContext(false);

/** True while a deep link is being resolved or its sheet is on screen. */
export function useDeepLinkBusy(): boolean {
  return useContext(DeepLinkBusyContext);
}
