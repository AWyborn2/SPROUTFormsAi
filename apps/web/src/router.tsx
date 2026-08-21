import { createBrowserRouter, type RouteObject } from 'react-router-dom';
import { RootLayout } from './layouts/RootLayout.js';
import { AppShell } from './layouts/AppShell.js';
import { RequireAuth, RequireSetupAccess, RootRedirect } from './components/AuthGate.js';
import { ScreenPlaceholder } from './screens/ScreenPlaceholder.js';
import { LoginScreen } from './screens/onboarding/LoginScreen.js';
import { OrgSetupScreen } from './screens/onboarding/OrgSetupScreen.js';
import { BrandingScreen } from './screens/onboarding/BrandingScreen.js';
import { DashboardScreen } from './screens/DashboardScreen.js';
import { TemplatesScreen } from './screens/TemplatesScreen.js';
import { SubmissionsScreen } from './screens/SubmissionsScreen.js';
import { SubmissionDetailScreen } from './screens/SubmissionDetailScreen.js';
import { BuilderScreen } from './screens/builder/BuilderScreen.js';
import { ImportUploadScreen } from './screens/import/ImportUploadScreen.js';
import { ImportReviewScreen } from './screens/import/ImportReviewScreen.js';
import { ImportPublishScreen } from './screens/import/ImportPublishScreen.js';
import { FillScreen } from './screens/fill/FillScreen.js';
import { InviteScreen } from './screens/invite/InviteScreen.js';
import { GeometryEditorScreen } from './screens/import/GeometryEditorScreen.js';
import { ResetPasswordScreen } from './screens/invite/ResetPasswordScreen.js';
import { ApiKeysScreen } from './screens/enterprise/ApiKeysScreen.js';
import { TeamScreen } from './screens/enterprise/TeamScreen.js';
import { TaxonomyScreen } from './screens/enterprise/TaxonomyScreen.js';
import { RolesScreen } from './screens/enterprise/RolesScreen.js';
import { AuditScreen } from './screens/enterprise/AuditScreen.js';
import { BillingScreen } from './screens/enterprise/BillingScreen.js';
import { ClientBrandsScreen } from './screens/enterprise/ClientBrandsScreen.js';
import { WhiteLabelScreen } from './screens/enterprise/WhiteLabelScreen.js';
import { CompetencyScreen } from './screens/enterprise/CompetencyScreen.js';
import { ExtractionInsightsScreen } from './screens/enterprise/ExtractionInsightsScreen.js';
import { WorkingListScreen } from './screens/enterprise/WorkingListScreen.js';
import { ProfileScreen } from './screens/enterprise/ProfileScreen.js';
import { WorkforceImportScreen } from './screens/enterprise/WorkforceImportScreen.js';
import { ComplianceScreen } from './screens/enterprise/ComplianceScreen.js';
import { TrainingMatrixScreen } from './screens/enterprise/TrainingMatrixScreen.js';
import { TrainingSummaryScreen } from './screens/enterprise/TrainingSummaryScreen.js';
import { AssessmentCasesScreen } from './screens/assessments/AssessmentCasesScreen.js';
import { AssessorQueueScreen } from './screens/assessments/AssessorQueueScreen.js';
import { AssessmentCaseScreen } from './screens/assessments/AssessmentCaseScreen.js';
import { AssessmentDashboard } from './screens/assessments/AssessmentDashboard.js';
import { WorkflowBuilderScreen } from './screens/assessments/WorkflowBuilderScreen.js';
import { BuilderScreen as AssessmentBuilderScreen } from './screens/assessments/builder/BuilderScreen.js';
import { CasePartFillScreen } from './screens/assessments/CasePartFillScreen.js';
import { MobileScreen } from './screens/mobile/MobileScreen.js';
import { ChcIntakeScreen } from './screens/chc/ChcIntakeScreen.js';
import { SCREENS, type ScreenDef } from './lib/screens.js';

/** Screens implemented for real; everything else renders the Phase-0 placeholder. */
const REAL_SCREENS: Record<string, React.ReactNode> = {
  login: <LoginScreen />,
  'org-setup': <OrgSetupScreen />,
  branding: <BrandingScreen />,
  dashboard: <DashboardScreen />,
  templates: <TemplatesScreen />,
  builder: <BuilderScreen />,
  'import-1': <ImportUploadScreen />,
  'import-2': <ImportReviewScreen />,
  'import-3': <ImportPublishScreen />,
  submissions: <SubmissionsScreen />,
  'submission-detail': <SubmissionDetailScreen />,
  fill: <FillScreen />,
  invite: <InviteScreen />,
  'reset-password': <ResetPasswordScreen />,
  team: <TeamScreen />,
  taxonomy: <TaxonomyScreen />,
  'api-keys': <ApiKeysScreen />,
  roles: <RolesScreen />,
  audit: <AuditScreen />,
  billing: <BillingScreen />,
  whitelabel: <WhiteLabelScreen />,
  'client-brands': <ClientBrandsScreen />,
  competency: <CompetencyScreen />,
  'extraction-insights': <ExtractionInsightsScreen />,
  'working-list': <WorkingListScreen />,
  compliance: <ComplianceScreen />,
  'training-matrix': <TrainingMatrixScreen />,
  'training-summary': <TrainingSummaryScreen />,
  profile: <ProfileScreen />,
  'workforce-import': <WorkforceImportScreen />,
  'my-profile': <ProfileScreen />,
  assessments: <AssessmentCasesScreen />,
  'assessment-queue': <AssessorQueueScreen />,
  'assessment-progress': <AssessmentDashboard />,
  'workflow-builder': <WorkflowBuilderScreen />,
  'assessment-builder': <AssessmentBuilderScreen />,
  'assessment-builder-draft': <AssessmentBuilderScreen />,
  'assessment-case': <AssessmentCaseScreen />,
  'assessment-part-fill': <CasePartFillScreen />,
  'geometry-editor': <GeometryEditorScreen />,
  'chc-intake': <ChcIntakeScreen />,
  mobile: <MobileScreen />,
};

function elementFor(s: ScreenDef): React.ReactNode {
  return REAL_SCREENS[s.key] ?? <ScreenPlaceholder screen={s} />;
}

const appScreens = SCREENS.filter((s) => s.shell === 'app');
// The mobile field app (/m) is authenticated — it posts real submissions —
// but renders its own device chrome, so it sits under RequireAuth WITHOUT AppShell.
const mobileScreens = SCREENS.filter((s) => s.shell === 'mobile');
// Everything else (onboarding + the public /fill/:token page) stays OUTSIDE
// RequireAuth — an external fill visitor is logged out by design.
const standaloneScreens = SCREENS.filter((s) => s.shell !== 'app' && s.shell !== 'mobile');
// The onboarding wizard is standalone chrome but not public: it needs a signed-in
// owner/admin of a team org with onboarding still pending (`RequireSetupAccess`).
const SETUP_SCREEN_KEYS = new Set(['org-setup', 'branding']);

const appRoutes: RouteObject[] = appScreens.map((s) => ({
  path: s.path,
  element: elementFor(s),
}));

const mobileRoutes: RouteObject[] = mobileScreens.map((s) => ({
  path: s.path,
  element: elementFor(s),
}));

const standaloneRoutes: RouteObject[] = standaloneScreens
  .filter((s) => !SETUP_SCREEN_KEYS.has(s.key))
  .map((s) => ({ path: s.path, element: elementFor(s) }));

const setupRoutes: RouteObject[] = standaloneScreens
  .filter((s) => SETUP_SCREEN_KEYS.has(s.key))
  .map((s) => ({ path: s.path, element: elementFor(s) }));

export const router: ReturnType<typeof createBrowserRouter> = createBrowserRouter([
  {
    element: <RootLayout />,
    children: [
      { path: '/', element: <RootRedirect /> },
      ...standaloneRoutes,
      { element: <RequireSetupAccess />, children: setupRoutes },
      {
        element: <RequireAuth />,
        children: [{ element: <AppShell />, children: appRoutes }, ...mobileRoutes],
      },
      { path: '*', element: <RootRedirect /> },
    ],
  },
]);
