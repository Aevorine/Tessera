# Windows 凭据管理器（普通凭据）读写：DPAPI 按当前 Windows 账户加密，其他账户读不到。由同目录脚本 dot-source。
if (-not ('TesseraCredMan' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class TesseraCredMan {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWriteW(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredReadW(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  const int GENERIC = 1, PERSIST_LOCAL_MACHINE = 2;

  public static void Write(string target, string user, string secret) {
    byte[] blob = Encoding.Unicode.GetBytes(secret);
    IntPtr p = Marshal.AllocHGlobal(blob.Length);
    try {
      Marshal.Copy(blob, 0, p, blob.Length);
      var c = new CREDENTIAL { Type = GENERIC, TargetName = target, UserName = user,
        CredentialBlob = p, CredentialBlobSize = blob.Length, Persist = PERSIST_LOCAL_MACHINE };
      if (!CredWriteW(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { Array.Clear(blob, 0, blob.Length); Marshal.FreeHGlobal(p); }
  }
  public static string Read(string target) {
    IntPtr p;
    if (!CredReadW(target, GENERIC, 0, out p)) return null;
    try {
      var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      return c.CredentialBlobSize == 0 ? "" : Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2);
    } finally { CredFree(p); }
  }
  public static bool Delete(string target) { return CredDeleteW(target, GENERIC, 0); }
}
'@
}

$TesseraStoreTarget = 'Tessera/AndroidSigning/storePassword'
$TesseraKeyTarget = 'Tessera/AndroidSigning/keyPassword'
