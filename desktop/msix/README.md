# Nexum Store package (MSIX)

Built by `.github/workflows/desktop-store.yml`. Each run has two artifacts.

## nexum-store-msix: upload this to Partner Center

`Nexum_<version>_x64.msix`, unsigned. The Store signs it. Upload it under
your submission's **Packages** page.

Each new submission needs a higher version: raise `version` in
`desktop/src-tauri/tauri.conf.json` (`0.1.0` becomes package `0.1.0.0`).

## nexum-test-msix: try it on a PC first

The same package, signed with a throwaway certificate. Windows only installs
it once that certificate is trusted, so this is a one-off step on your own
test PC:

1. Unzip the artifact.
2. Open **PowerShell as administrator** in that folder and run:

   ```
   Import-Certificate -FilePath .\nexum-test.cer `
     -CertStoreLocation Cert:\LocalMachine\TrustedPeople
   ```

3. Double-click the `_test.msix` file and choose **Install**.

To remove the certificate afterwards: run `certlm.msc`, open
**Trusted People > Certificates**, and delete the one issued to the
Publisher value.

Before installing the test copy, uninstall any Nexum you installed with the
.exe/.msi installer, so you are testing the packaged one.

What the Store build leaves out: its own "Check for updates" (the Store
updates it) and "Start at login".
