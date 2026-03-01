/**
 * Columns to select for job listings. Excludes jobDescription to avoid loading
 * large text on list pages. Load description only on job detail page.
 */
const JOBS_LIST_COLUMNS = [
  "id",
  "created_at",
  "updated_at",
  "companyName",
  "user_uid",
  "company_email",
  "jobName",
  "jobSalary",
  "job_experience",
  "job_city",
  "job_address",
  "job_type",
  "work_mode",
  "jobIsUrgent",
  "category_id",
  "job_premium_status",
  "premium_until",
  "isHelio",
  "helio_url",
  "job_status",
  "cvs_sent",
  "company_logo",
  "jobSalary_min",
  "view_count",
  "expires_at",
  "prioritize",
  "dont_send_email",
  "marketing_email_sent",
  "cv_submissions_email_sent",
  "disable_cv_filter",
  "accept_form_submissions",
  "candidates_must_be_exact_match",
];

module.exports = { JOBS_LIST_COLUMNS };
