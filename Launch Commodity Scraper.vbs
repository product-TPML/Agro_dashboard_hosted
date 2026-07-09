Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
command = "cmd /c cd /d """ & baseDir & """ && node scrape_krama.js --ui"
shell.Run command, 0, False
