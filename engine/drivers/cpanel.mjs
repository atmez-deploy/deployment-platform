// cPanel static publisher — automated provisioning + deploy for cPanel-based shared hosts.
// PURE: emits a deterministic step plan; the executor turns steps into cPanel UAPI calls
// (curl) + an upload. Unlike Hostinger shared, cPanel exposes UAPI to create subdomains
// and FTP accounts programmatically, so onboarding here can be fully automated.
//
// Secrets (cPanel API token, FTP password) are injected at runtime via env — never in the
// plan. See docs; UAPI refs: SubDomain::addsubdomain, Ftp::add_ftp.
//
// Flow:
//   1. provision_subdomain  (UAPI SubDomain/addsubdomain) — idempotent-ish (ignore "exists")
//   2. provision_ftp        (UAPI Ftp/add_ftp)            — optional, only if requested
//   3. upload               (ftps mirror OR ssh rsync into the subdomain docroot)
//   4. verify               (https URL returns ok)

function assertLabel(s, what) {
  if (!/^[a-zA-Z0-9._-]+$/.test(String(s ?? ""))) throw new Error(`invalid ${what}: ${s}`);
  return s;
}

/**
 * @param {Object} args
 * @param {Object} args.connection  { host, port?, username, apiTokenRef, transfer? ("ftps"|"rsync"), ftpPasswordRef? }
 * @param {string} args.subdomain   subdomain label (e.g. "app" for app.example.com)
 * @param {string} args.rootDomain  the cPanel account's main domain (e.g. "example.com")
 * @param {string} args.docroot     docroot relative to home (e.g. "public_html/app")
 * @param {string} args.localDir    built site dir to upload
 * @param {boolean} [args.createFtp] also create a scoped FTP account for this subdomain
 * @param {string} [args.ftpUser]   ftp account name (required if createFtp)
 * @returns {{driver, mode, steps}}
 */
export function planDeploy({ connection, subdomain, rootDomain, docroot, localDir, createFtp = false, ftpUser }) {
  if (!connection?.host || !connection?.username) throw new Error("connection.host + username required");
  assertLabel(subdomain, "subdomain");
  assertLabel(rootDomain, "rootDomain");
  if (!docroot) throw new Error("docroot is required");
  if (!localDir) throw new Error("localDir is required");
  const fqdn = `${subdomain}.${rootDomain}`;

  const steps = [
    {
      type: "uapi",
      module: "SubDomain",
      func: "addsubdomain",
      params: { domain: subdomain, rootdomain: rootDomain, dir: docroot },
      ignoreIfExists: true,
      note: `create subdomain ${fqdn} -> ${docroot}`,
    },
  ];

  if (createFtp) {
    if (!ftpUser) throw new Error("ftpUser is required when createFtp is true");
    assertLabel(ftpUser, "ftpUser");
    steps.push({
      type: "uapi",
      module: "Ftp",
      func: "add_ftp",
      // password comes from env at run time (ftpPasswordRef); the executor injects it
      params: { user: ftpUser, homedir: docroot },
      passwordFromEnv: connection.ftpPasswordRef ?? "FTP_PASSWORD",
      ignoreIfExists: true,
      note: `create FTP account ${ftpUser} -> ${docroot}`,
    });
  }

  const transfer = connection.transfer ?? "ftps";
  steps.push({
    type: "upload",
    method: transfer,
    localDir,
    docroot,
    note: `publish built site into ${docroot} via ${transfer}`,
  });

  steps.push({
    type: "verify",
    url: `https://${fqdn}/`,
    note: "verify the subdomain serves the site (SSL is managed by cPanel/AutoSSL)",
  });

  return { driver: "cpanel", mode: "provision-and-publish", identity: { fqdn, docroot }, steps };
}
