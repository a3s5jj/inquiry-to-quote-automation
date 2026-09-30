# Security and privacy

Do not open an issue with real email, customer, credential, database, or n8n execution
data. Reproduce problems with the synthetic fixtures in this repository.

Keep runtime credentials inside n8n's credential store. Keep the private live-test
settings (`config/settings.local.json`), private builds (`private/`), execution exports,
database dumps, and account screenshots out of Git. The checked-in workflow exports must
remain inactive and credential-free.
