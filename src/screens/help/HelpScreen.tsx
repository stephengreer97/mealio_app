import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Linking,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Colors, Radius } from '../../constants/colors';

interface FAQItem {
  question: string;
  answer: string;
}

const FAQ_SECTIONS: { title: string; items: FAQItem[] }[] = [
  {
    title: 'Getting Started',
    items: [
      {
        question: 'What is Mealio?',
        answer:
          'Mealio is an app that helps you save meal recipes and quickly add their ingredients to your grocery cart. Save time planning meals and shopping.',
      },
      {
        question: 'How do I save a meal?',
        answer:
          'Browse the Discover tab to find meals you like. Tap on any meal and press "Save to My Meals". Choose which grocery store you shop at, and the meal will appear in your My Meals tab.',
      },
      {
        question: 'Which grocery stores are supported?',
        answer:
          'Mealio currently supports H-E-B, Walmart, and Kroger. Cart-add functionality is available in the Mealio browser extension — open mealio.co to learn more.',
      },
    ],
  },
  {
    title: 'My Meals',
    items: [
      {
        question: 'How do I edit a saved meal?',
        answer:
          'Go to My Meals, tap on the meal you want to edit, then tap "Edit" in the top right. You can change the name and ingredients.',
      },
      {
        question: 'I accidentally deleted a meal. Can I recover it?',
        answer:
          'Yes! Go to Account → Deleted Meals. Deleted meals are kept for 30 days before being permanently removed. Tap "Restore" to bring it back.',
      },
      {
        question: 'How many meals can I save?',
        answer:
          'Free accounts can save up to 10 meals per store. Upgrade to Pro for unlimited meals and other premium features.',
      },
    ],
  },
  {
    title: 'Account & Security',
    items: [
      {
        question: 'How do I change my password?',
        answer:
          'Go to Account → Change Password. Enter your current password and your new password, then tap "Update Password".',
      },
      {
        question: 'I forgot my password. What do I do?',
        answer:
          'On the sign-in screen, tap "Forgot password?". Enter your email and we\'ll send a reset link. The link opens on mealio.co — reset there, then sign back in.',
      },
      {
        question: 'How do I verify my email?',
        answer:
          'After signing up, check your inbox for a verification email. Click the link — it opens mealio.co. Once verified, return to the app and sign in.',
      },
    ],
  },
  {
    title: 'Creators',
    items: [
      {
        question: 'How do I become a creator?',
        answer:
          'Tap the Creator tab and fill out the application form. We\'ll review it within 3-5 business days. Approved creators can publish meals visible to all users.',
      },
      {
        question: 'How does the revenue share work?',
        answer:
          'Creators earn a percentage of subscription revenue based on how many times their meals are saved by Pro users each quarter.',
      },
    ],
  },
];

function FAQSection({ title, items }: { title: string; items: FAQItem[] }) {
  const [expanded, setExpanded] = React.useState<number | null>(null);

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {items.map((item, i) => (
        <TouchableOpacity
          key={i}
          style={styles.faqItem}
          onPress={() => setExpanded(expanded === i ? null : i)}
          activeOpacity={0.7}
        >
          <View style={styles.faqHeader}>
            <Text style={styles.question}>{item.question}</Text>
            <Ionicons
              name={expanded === i ? 'chevron-up' : 'chevron-down'}
              size={18}
              color={Colors.text3}
            />
          </View>
          {expanded === i && <Text style={styles.answer}>{item.answer}</Text>}
        </TouchableOpacity>
      ))}
    </View>
  );
}

export default function HelpScreen() {
  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.pageTitle}>Help & FAQ</Text>

        {FAQ_SECTIONS.map((section) => (
          <FAQSection key={section.title} title={section.title} items={section.items} />
        ))}

        <View style={styles.contact}>
          <Text style={styles.contactTitle}>Still need help?</Text>
          <Text style={styles.contactBody}>
            Our support team is happy to help you with any questions.
          </Text>
          <TouchableOpacity
            style={styles.contactBtn}
            onPress={() => Linking.openURL('mailto:contact@mealio.co')}
          >
            <Ionicons name="mail-outline" size={20} color={Colors.brand} />
            <Text style={styles.contactBtnText}>Contact Support</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: Colors.bg },
  scroll: { padding: 16, paddingBottom: 40 },
  pageTitle: { fontSize: 28, fontFamily: 'Inter_700Bold', color: Colors.text1, marginBottom: 20 },
  section: { marginBottom: 24 },
  sectionTitle: {
    fontSize: 15,
    fontFamily: 'Inter_700Bold',
    color: Colors.text3,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 10,
  },
  faqItem: {
    backgroundColor: Colors.surfaceRaised,
    borderRadius: Radius.card,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: 14,
    marginBottom: 8,
  },
  faqHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  question: {
    flex: 1,
    fontSize: 15,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.text1,
    marginRight: 10,
    lineHeight: 22,
  },
  answer: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text2,
    lineHeight: 22,
    marginTop: 10,
  },
  contact: {
    backgroundColor: Colors.brandLight,
    borderRadius: Radius.card,
    padding: 20,
    alignItems: 'center',
  },
  contactTitle: {
    fontSize: 18,
    fontFamily: 'Inter_700Bold',
    color: Colors.text1,
    marginBottom: 8,
  },
  contactBody: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    color: Colors.text2,
    textAlign: 'center',
    marginBottom: 16,
    lineHeight: 20,
  },
  contactBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.surfaceRaised,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: Radius.button,
    borderWidth: 1,
    borderColor: Colors.brand,
  },
  contactBtnText: {
    fontSize: 16,
    fontFamily: 'Inter_600SemiBold',
    color: Colors.brand,
  },
});
