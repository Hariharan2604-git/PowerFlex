# Security policy

PowerFlex is an independent research prototype. It is not approved for production scheduling or for processing confidential company workload data.

## Safe use

- Do not commit raw scheduler snapshots, site signal files, job-ID maps, credentials, or confidential workload data.
- The Slurm adapter is advisory-only and runs `scontrol show jobs --json` in live mode. It has no command to submit, update, hold, release, or cancel jobs.
- Review and validate every recommendation before using it. The project has not undergone an enterprise security assessment.

## Reporting a vulnerability

Please do not post sensitive vulnerability details or operational data in a public issue. Use GitHub's private vulnerability reporting for this repository if it is enabled; otherwise contact the repository owner privately through GitHub.
