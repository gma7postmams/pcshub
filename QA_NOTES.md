# Promotional Content Hub - Initial QA Review

## Authentication & Security

✅ Successfully logged in using the seeded Administrator account.

✅ System correctly forced a password change on first login.

✅ System correctly enforced 2FA enrollment for the Administrator account before allowing access to the application.

✅ User login and role validation are working as expected.

✅ Group permission enforcement is working correctly.

---

## Main Navigation

✅ The following modules loaded successfully:

- Dashboard
- Ingest Tracker
- Work Load Tracker
- Approval
- Reports
- Admin

---

## Dashboard

✅ Dashboard loads successfully.

✅ Dashboard data and widgets are displayed correctly.

---

## Ingest Workflow

✅ Ingest Tracker loads successfully.

✅ Record creation is working.

✅ Record editing is working.

✅ Submission for approval is working.

✅ End-to-end ingest workflow is functioning as expected.

---

## Approval Workflow

✅ Approval module loads successfully.

✅ Approval process is working correctly.

✅ Rejection process is working correctly.

✅ End-to-end approval workflow is functioning as expected.

---

## Reports

✅ Reports module loads successfully.

✅ Report generation is functioning correctly.

✅ Report data is displayed correctly.

---

## Administration Module

### Users

✅ Users page loads successfully.

✅ Successfully created a new user account.

✅ User login and role validation are working as expected.

### Groups

✅ Groups page loads successfully.

✅ Successfully created a new group.

✅ Group permission enforcement is working correctly.

### Roles

✅ Roles page loads successfully.

### Dropdowns

✅ Dropdowns page loads successfully.

#### Program

✅ Successfully added a Program.

✅ Successfully edited a Program.

✅ Successfully deleted a Program.

#### Platform

✅ Successfully added a Platform.

✅ Successfully edited a Platform.

✅ Successfully deleted a Platform.

### Branding

✅ Branding page loads successfully.

✅ Able to update the following settings:

- Application Name
- Tagline
- Logo
- Theme Selection

✅ Available themes are loading correctly:

- Midnight
- Sunset
- Purple
- Ocean
- Forest
- Rose
- Graphite
- Custom Theme

✅ "Save Branding & Theme" button is functioning correctly and saves changes successfully.

✅ Branding changes are applied correctly across sessions and users.

⚠️ "Reset Preview" button does not appear to function as expected. No visible action occurs when clicked.

### Audit Log

✅ Audit Log page loads successfully.

✅ Audit Log is visible only to Administrators as intended.

💡 Enhancement Suggestion:

- Non-administrative users could have access to a personal activity log showing only their own actions (e.g., login history, profile changes, records created, or records updated).
- Full Audit Log should remain restricted to Administrators for security and compliance purposes.

---

## Findings

### Documentation

⚠️ README references `.env.example`, but the file is not included in the repository, preventing a fresh installation using the documented setup procedure.

### Functional Issues

⚠️ Branding → "Reset Preview" button appears to be non-functional and requires further investigation.

### Enhancement Opportunities

💡 User Activity Log

- Provide users with visibility into their own activity history.
- Maintain Administrator-only access to the complete system Audit Log.

---

## Overall Status

✅ Initial setup completed successfully.

✅ Authentication, password reset, and 2FA onboarding are working as designed.

✅ Core application navigation is functioning properly.

✅ Dashboard, Ingest, Approval, and Reports modules are functioning as expected.

✅ User management, role validation, group permissions, dropdown management, and branding configuration are working as expected.

✅ Branding settings persist correctly across sessions and users.

✅ Audit Log access control is functioning correctly.

✅ No critical or blocking issues were identified during testing.

### Remaining Activities

- End-to-end workflow testing with multiple user


### Audit Log Usability Improvements

💡 The Audit Log currently exposes technical action names, entity identifiers, and raw JSON data.

Examples:

- auth.login_failed
- dropdown_option #12
- {"reason":"unknown_user","username":"admin@example.com"}

Recommendation:

- Convert action names into human-readable descriptions.
- Replace internal entity IDs with meaningful entity names.
- Display user-friendly detail messages instead of raw JSON.
- Provide an optional "View Details" action for advanced technical information.
- Improve readability for administrators performing audits and investigations.