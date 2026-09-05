import React from 'react';
import { View } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { useCreatorDrafts } from '../context/CreatorDraftsContext';
import { Colors } from '../constants/colors';
import DiscoverScreen from '../screens/discover/DiscoverScreen';
import MyMealsScreen from '../screens/mymeals/MyMealsScreen';
import AccountScreen from '../screens/account/AccountScreen';
import CreatorPortalScreen from '../screens/creator/CreatorPortalScreen';
import HelpScreen from '../screens/help/HelpScreen';
import BroadcastBanner from '../components/BroadcastBanner';

export type MainTabsParamList = {
  Discover: undefined;
  MyMeals: undefined;
  Account: undefined;
  /**
   * `openQueue` lands a notification tap straight on the review queue (MEAL-89)
   * rather than on the portal it sits inside. It is a param rather than a route
   * of its own so the tab bar stays on screen the whole time: a creator who
   * tapped "2 recipes ready" while meaning to add a meal to their cart is still
   * one tap from Discover, which is what "never blocking" has to mean on a
   * phone. `draftId` rides along for the same reason the push payload carries
   * it — the tap named a specific recipe.
   */
  Creator: { openQueue?: boolean; draftId?: string } | undefined;
  Help: undefined;
};

const Tab = createBottomTabNavigator<MainTabsParamList>();

export default function MainTabs() {
  const { isCreator } = useAuth();
  // How many drafts are waiting. A badge and nothing else — see
  // CreatorDraftsContext for why nothing here interrupts.
  const { waiting } = useCreatorDrafts();

  return (
    <View style={{ flex: 1 }}>
      <BroadcastBanner />
      <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: Colors.brand,
        tabBarInactiveTintColor: Colors.text3,
        tabBarStyle: {
          backgroundColor: Colors.surfaceRaised,
          borderTopColor: Colors.border,
        },
        tabBarIcon: ({ focused, color, size }) => {
          let iconName: keyof typeof Ionicons.glyphMap = 'compass-outline';
          if (route.name === 'Discover') iconName = focused ? 'compass' : 'compass-outline';
          else if (route.name === 'MyMeals') iconName = focused ? 'restaurant' : 'restaurant-outline';
          else if (route.name === 'Account') iconName = focused ? 'person' : 'person-outline';
          else if (route.name === 'Creator') iconName = focused ? 'star' : 'star-outline';
          else if (route.name === 'Help') iconName = focused ? 'help-circle' : 'help-circle-outline';
          return <Ionicons name={iconName} size={size} color={color} />;
        },
      })}
    >
      <Tab.Screen
        name="Discover"
        component={DiscoverScreen}
        options={{ tabBarLabel: 'Discover', tabBarButtonTestID: 'tab-discover' }}
      />
      <Tab.Screen
        name="MyMeals"
        component={MyMealsScreen}
        options={{ tabBarLabel: 'My Meals', tabBarButtonTestID: 'tab-mymeals' }}
      />
      <Tab.Screen
        name="Account"
        component={AccountScreen}
        options={{ tabBarLabel: 'Account', tabBarButtonTestID: 'tab-account' }}
      />
      {isCreator && (
        <Tab.Screen
          name="Creator"
          component={CreatorPortalScreen}
          options={{
            tabBarLabel: 'Creator',
            tabBarButtonTestID: 'tab-creator',
            // The COUNT, never a dot. "10" tells a creator to set an evening
            // aside and "1" tells them it is a two-minute job; a dot says the
            // same thing to both of them, which is the one piece of information
            // they actually need in order to decide when to look.
            //
            // Undefined rather than 0 — React Navigation renders a `0` badge as
            // a visible zero, which reads as a broken counter rather than as
            // nothing to do.
            tabBarBadge: waiting > 0 ? (waiting > 99 ? '99+' : waiting) : undefined,
            tabBarBadgeStyle: { backgroundColor: Colors.brand, fontSize: 10 },
          }}
        />
      )}
      <Tab.Screen
        name="Help"
        component={HelpScreen}
        options={{ tabBarLabel: '', tabBarShowLabel: false }}
      />
      </Tab.Navigator>
    </View>
  );
}
