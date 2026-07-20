import { Outlet } from 'react-router-dom';
import { KeyboardProvider } from '../lib/keyboard/KeyboardProvider.js';
import { OnboardingProvider } from '../lib/onboarding.js';

/** App root — installs the global keyboard layer and onboarding state. */
export function RootLayout() {
  return (
    <OnboardingProvider>
      <KeyboardProvider>
        <Outlet />
      </KeyboardProvider>
    </OnboardingProvider>
  );
}
