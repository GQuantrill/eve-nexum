# Nexum Store package (MSIX)

Built by `.github/workflows/desktop-store.yml`. Each run has two artifacts.

## nexum-store-msix: upload this to Partner Center

`Nexum_<version>_x64.msix`, unsigned. The Store signs it. Upload it under
your submission's **Packages** page.

Each new submission needs a higher version: raise `version` in
`desktop/src-tauri/tauri.conf.json` (`0.1.0` becomes package `0.1.0.0`).

## nexum-test-msix: try it on a PC first

The same package, signed with a throwaway certificate.

1. Unzip the artifact.
2. Double-click **Install-test.cmd** and say **Yes** to the admin prompt.
   (If Windows says it protected your PC: **More info > Run anyway**.)
   It trusts the certificate on this PC and installs the app.
3. Find **Eve-Nexum** in the Start menu.

By hand instead, in PowerShell as administrator:

```
Import-Certificate -FilePath .\nexum-test.cer `
  -CertStoreLocation Cert:\LocalMachine\TrustedPeople
Add-AppxPackage -Path .\<name>_test.msix
```

To remove the certificate afterwards: run `certlm.msc`, open
**Trusted People > Certificates** and **Trusted Root Certification
Authorities > Certificates**, and delete the one issued to the Publisher
value (CN=B1C20CC8-...).

Before installing the test copy, uninstall any Nexum you installed with the
.exe/.msi installer, so you are testing the packaged one.

What the Store build leaves out: its own "Check for updates" (the Store
updates it) and "Start at login".
