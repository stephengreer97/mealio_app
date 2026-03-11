import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../context/AuthContext';
import { Colors } from '../constants/colors';
import DiscoverScreen from '../screens/discover/DiscoverScreen';
import MyMealsScreen from '../screens/mymeals/MyMealsScreen';
import AccountScreen from '../screens/account/AccountScreen';
import CreatorPortalScreen from '../screens/creator/CreatorPortalScreen';
import HelpScreen from '../screens/help/HelpScreen';

export type MainTabsParamList = {
  Discover: undefined;
  MyMeals: undefined;
  Account: undefined;
  Creator: undefined;
  Help: undefined;
};

const Tab = createBottomTabNavigator<MainTabsParamList>();

export default function MainTabs() {
  const { isCreator } = useAuth();

  return (
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
      <Tab.Screen name="Discover" component={DiscoverScreen} options={{ tabBarLabel: 'Discover' }} />
      <Tab.Screen name="MyMeals" component={MyMealsScreen} options={{ tabBarLabel: 'My Meals' }} />
      <Tab.Screen name="Account" component={AccountScreen} options={{ tabBarLabel: 'Account' }} />
      {isCreator && (
        <Tab.Screen
          name="Creator"
          component={CreatorPortalScreen}
          options={{ tabBarLabel: 'Creator' }}
        />
      )}
      <Tab.Screen
        name="Help"
        component={HelpScreen}
        options={{ tabBarLabel: '', tabBarShowLabel: false }}
      />
    </Tab.Navigator>
  );
}
