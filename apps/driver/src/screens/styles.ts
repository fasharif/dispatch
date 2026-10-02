import { StyleSheet } from 'react-native';

export const ui = StyleSheet.create({
  screen: { flex: 1, padding: 20, paddingTop: 60, gap: 12, backgroundColor: '#f6f7f9' },
  title: { fontSize: 26, fontWeight: '700', color: '#1f2328' },
  subtitle: { fontSize: 18, fontWeight: '600', color: '#1f2328' },
  muted: { color: '#59636e' },
  label: { fontWeight: '600', color: '#1f2328' },
  input: {
    borderWidth: 1,
    borderColor: '#d1d9e0',
    borderRadius: 8,
    padding: 12,
    backgroundColor: '#ffffff',
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: 10,
    padding: 16,
    gap: 8,
    borderWidth: 1,
    borderColor: '#d1d9e0',
  },
  primary: { backgroundColor: '#0b57d0', borderRadius: 8, padding: 14, alignItems: 'center' },
  primaryText: { color: '#ffffff', fontWeight: '600', fontSize: 16 },
  secondary: {
    borderWidth: 1,
    borderColor: '#d1d9e0',
    borderRadius: 8,
    padding: 14,
    alignItems: 'center',
  },
  secondaryText: { color: '#1f2328', fontWeight: '600' },
  danger: { color: '#cf222e', fontWeight: '600' },
  error: { color: '#cf222e' },
  notice: { backgroundColor: '#ddf4ff', padding: 10, borderRadius: 8 },
});
