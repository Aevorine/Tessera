; 安装程序的「数据保存位置」页面。
;
; electron-builder 通过 nsis.include 把这个文件包含进生成的 NSIS 脚本，并在几个
; 固定时机调用下面这些宏。名字必须和 electron-builder 约定的一致，写错了不会报
; 错——只是永远不被调用，安装程序看起来一切正常但这一页不出现。
;
; ## 为什么要有这一页
;
; 安装位置和数据位置是**两个不同的决定**，把它们绑在一起是常见但错误的做法：
;
;   * 程序装在哪，取决于磁盘空间和你对 C 盘的洁癖，装错了重装一遍就好。
;   * 数据存在哪，取决于你的备份方案、有没有加密卷、要不要跟着同步盘走。**数据
;     放错地方，等你发现时它已经在那里躺了半年。**
;
; 而且卸载不删数据（deleteAppDataOnUninstall: false），所以数据目录的生命周期
; 本来就比安装目录长。让它们能分开选是符合实际的。
;
; ## 与应用侧的契约
;
; 这一页只做一件事：把选中的路径写进
;   %LOCALAPPDATA%\Tessera\data-location.json
; 格式是 {"dataDir": "<路径>"}。读它的是 modules/file_vault/data_dir.py 的
; read_configured_data_dir()。**改这里的格式必须同步改那边**——那边读不出来时
; 会静默回落到默认目录，也就是说写错了不会报错，只会让用户选的路径"不生效"。
;
; 路径里的反斜杠要转义成 \\，因为 JSON 字符串里 \ 是转义引导符。C:\Vault 直接
; 写进去会得到一个非法 JSON，而 Python 那边解析失败同样是静默回落。

!include "LogicLib.nsh"
!include "nsDialogs.nsh"
!include "FileFunc.nsh"
; WM_SETTEXT 用来直接写这一页的标题栏，见 Ideal1SetHeader 的说明。
; 这几个头文件都有 include 卫哨，重复 include 是安全的。
!include "WinMessages.nsh"

; $Ideal1DataDir 必须是全局的：它由 preInit 赋初值，而 electron-builder 模板里的
; `Function .onInit`（preInit 就插在里面）**两遍都会编译** —— 生成安装程序那一遍
; 和生成卸载程序那一遍。所以它在两遍里都被引用，不能挪进下面的 BUILD_UNINSTALLER
; 守卫里，否则卸载程序那一遍会报"变量未声明"。
;
; 另外三个是 nsDialogs 的控件句柄，只在自定义页那几个函数里用到，跟着那些函数
; 一起放进守卫里（见那里的说明）。留在外面会得到：
;   warning 6001: Variable "Ideal1DataDirPage" not referenced or never set,
;                 wasting memory!
; 而 electron-builder 给 makensis 传了 -WX，这条警告同样会让构建失败。
Var Ideal1DataDir

; 用户没动过这一页时的默认值，和 data_dir.py 的 default_data_dir() 一致。
!define IDEAL1_DEFAULT_DATA_DIR "$LOCALAPPDATA\Tessera\data"

; 跨设备守护进程的防火墙入站规则名。
;
; **必须和 electron/firewall.ts 里的 FIREWALL_RULE_NAME 一字不差**，那边靠这个
; 名字精确查询和删除。对不上的话，安装包加的规则和应用查的规则会变成两条互不
; 相干的东西——应用永远报"未放行"，用户在防火墙里却看得见规则明明在那儿。
;
; 纯 ASCII 是有意的：NSIS 脚本里的非 ASCII 字面量取决于 makensis 怎么解码源
; 文件，两边理解不一致时不会报错，只会静默地对不上。
!define TESSERA_FIREWALL_RULE "Tessera Cross-Device Sync"

;--------------------------------------------------------------------------
; 把 Windows 路径里的 \ 变成 \\，供 JSON 使用。
;
; 用 ${WordReplace}（FileFunc/WordFunc 提供）而不是自己写循环：NSIS 的字符串
; 处理很容易在遇到 $ 开头的变量展开时出意外，标准宏已经处理过这些。
;--------------------------------------------------------------------------
!include "WordFunc.nsh"
; WordReplace 两遍都要：安装那遍把路径里的 \ 转义进 JSON，卸载那遍剥掉从
; data-location.txt 读回来的行尾。两遍都引用到了，所以放在守卫外面是对的。
!insertmacro WordReplace

;--------------------------------------------------------------------------
; customPageAfterChangeDir —— 安装位置页之后插入我们这一页。
;
; 时机选这里而不是更早：用户刚刚做完"程序装哪"的决定，紧接着问"数据存哪"，
; 两个问题在同一个心智上下文里。放到欢迎页之前问，用户还不知道这是什么应用。
;--------------------------------------------------------------------------
!macro customPageAfterChangeDir
  Page custom Ideal1DataDirPageCreate Ideal1DataDirPageLeave
!macroend


;--------------------------------------------------------------------------
; 写这一页顶部的标题和副标题。
;
; **为什么不用 `!insertmacro MUI_HEADER_TEXT`**（本来该用它，我们踩过这个坑）：
; electron-builder 把这个文件 `!include` 进生成脚本的位置，在 `MUI2.nsh` 被
; include **之前**。而 `!insertmacro` 是**编译期**指令——它在解析到这一行时就要
; 求宏已经存在，不是等函数运行时才展开。于是整个安装包构建直接失败：
;
;     !insertmacro: macro named "MUI_HEADER_TEXT" not found!
;     !include: error in script: "...\nsis\installer.nsh" on line 75
;
; 这个错误只在 nsis 目标真正构建时才出现，portable 目标不受影响——也就是说
; 「免安装版构建成功」完全不能说明安装包是好的，两个目标必须分别验证过。
;
; 改成运行时直接给 MUI 的两个 header 静态控件发 WM_SETTEXT：1037 是标题，
; 1038 是副标题，这是 MUI 页面模板固定的控件 ID。这样既不依赖 MUI 的宏，也不
; 依赖它被 include 的先后顺序。
;--------------------------------------------------------------------------
; ==========================================================================
; 下面这几个函数**只属于安装程序**，必须用 BUILD_UNINSTALLER 挡住。
;
; electron-builder 会用同一份脚本跑**两遍** makensis：一遍生成安装程序，一遍
; 生成卸载程序（后者带 -DBUILD_UNINSTALLER）。而插入自定义页的那句
; `!insertmacro customPageAfterChangeDir` 在模板里位于 `!ifndef BUILD_UNINSTALLER`
; 之内——也就是说**卸载程序那一遍根本不会插入这一页**。
;
; 于是这几个函数在那一遍里定义了却没人引用，makensis 报：
;
;     warning 6010: install function "Ideal1DataDirPageCreate" not referenced
;                   - zeroing code (5-87) out
;     Error: warning treated as error
;
; electron-builder 给 makensis 传了 `-WX`（warning 视为 error），所以这条警告
; 直接让整个安装包构建失败。
;
; 值得记的一点：这个报错**看起来像"这一页没接上"**，而实际上它恰恰证明了
; 这一页在安装程序那一遍是接上的——不然第一遍也会报同样的警告。真正的问题只是
; 卸载程序那一遍不需要它。
; ==========================================================================
!ifndef BUILD_UNINSTALLER

; GetFileName（取路径最后一段）**只有安装程序那一遍用得到**——它唯一的调用点
; 是下面 Ideal1DataDirPageCreate 里那段"把 INSTDIR 规范成以 Tessera 结尾"。
;
; 所以它必须在这个守卫**里面**：放在外面的话，卸载程序那一遍会定义出一个没人
; 引用的函数，makensis 报 `warning 6010: ... not referenced - zeroing code out`，
; 而 electron-builder 给 makensis 传了 -WX，这条警告直接让构建失败。
; 上面那段大注释讲的就是这个坑，这里是它的第二个实例。
!insertmacro GetFileName

; nsDialogs 的控件句柄，只有这一页用得到。
Var Ideal1DataDirPage
Var Ideal1DataDirText
Var Ideal1DataDirBrowse

Function Ideal1SetHeader
  GetDlgItem $0 $HWNDPARENT 1037
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Choose where your vault is stored"
  GetDlgItem $0 $HWNDPARENT 1038
  SendMessage $0 ${WM_SETTEXT} 0 "STR:Your notes, passwords and clipboard history live here. This is separate from where the program is installed."
FunctionEnd

Function Ideal1DataDirPageCreate
  ; 静默安装（更新流程走的就是这条路）不能弹任何界面，否则更新会卡在一个没人
  ; 看得见的对话框上，表现为"点了更新之后应用再也没起来"。
  ${If} ${Silent}
    Abort
  ${EndIf}

  ; ---- 顺手把安装目录规范成以 \Tessera 结尾 ----
  ;
  ; 这一段放这里，是因为**这是目录页刚结束、INSTDIR 已经定下来的第一个会跑的
  ; 地方**。electron-builder 没有 "目录页离开" 这种钩子（它认的钩子只有
  ; customPageAfterChangeDir / customInstall / customUnInstall 等那几个，
  ; 名字写错不会报错、只是永远不被调用——见本文件开头那段警告）。
  ;
  ; 为什么要规范：NSIS 的目录页把用户在「浏览」里选中的路径**原样**当成 INSTDIR。
  ; 想换个盘装的人很自然地会选中自己那个"软件总目录"然后直接下一步——于是几百个
  ; 文件被直接铺在那个目录底下，跟别的软件混成一团，卸载时也不敢整目录删。默认值
  ; （`%LOCALAPPDATA%\Programs\Tessera`）本来就带产品名，所以只有用户**改过**
  ; 目录才会掉进这个坑，平时测试根本碰不到。
  ;
  ; 已经以 Tessera 结尾的不动，避免升级安装叠成 `...\Tessera\Tessera`。
  ; 静默安装走不到这里（上面已经 Abort），所以 `/D=` 指定的路径不受影响——
  ; 那是调用方明确给的，不该替他改。
  ${GetFileName} "$INSTDIR" $R0
  ${IfNot} $R0 == "Tessera"
    StrCpy $INSTDIR "$INSTDIR\Tessera"
  ${EndIf}

  ; 已经装过一次的机器不再问：配置文件已经存在，再问一遍等于给用户一个改路径
  ; 的机会却不搬数据，选了新路径就会看到一个空金库。改路径要走应用内的设置页，
  ; 那里会做迁移。
  ${If} ${FileExists} "$LOCALAPPDATA\Tessera\data-location.json"
    Abort
  ${EndIf}

  Call Ideal1SetHeader

  nsDialogs::Create 1018
  Pop $Ideal1DataDirPage
  ${If} $Ideal1DataDirPage == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 34u "All vault data stays on this machine and is encrypted at rest.$\r$\nUninstalling the app does not delete this folder."
  Pop $0

  ${NSD_CreateText} 0 44u 76% 13u "$Ideal1DataDir"
  Pop $Ideal1DataDirText

  ${NSD_CreateBrowseButton} 79% 44u 21% 13u "Browse..."
  Pop $Ideal1DataDirBrowse
  ${NSD_OnClick} $Ideal1DataDirBrowse Ideal1DataDirBrowseClick

  ${NSD_CreateLabel} 0 64u 100% 24u "Tip: pick a folder on a drive you actually back up. Putting it inside a cloud-sync folder works, but the vault files are large and change often."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function Ideal1DataDirBrowseClick
  nsDialogs::SelectFolderDialog "Choose the folder for your vault data" "$Ideal1DataDir"
  Pop $0
  ${If} $0 != error
    StrCpy $Ideal1DataDir "$0"
    ${NSD_SetText} $Ideal1DataDirText "$Ideal1DataDir"
  ${EndIf}
FunctionEnd

Function Ideal1DataDirPageLeave
  ${NSD_GetText} $Ideal1DataDirText $Ideal1DataDir
  ; 空值不接受：继续下去会写出 {"dataDir": ""}，Python 那边判定为无效并回落到
  ; 默认目录——用户以为自己选了个位置，实际没有。宁可拦在这里。
  ${If} $Ideal1DataDir == ""
    MessageBox MB_ICONEXCLAMATION|MB_OK "Please choose a folder for your vault data."
    Abort
  ${EndIf}
FunctionEnd

!endif ; BUILD_UNINSTALLER

;--------------------------------------------------------------------------
; preInit —— 在任何页面出现之前跑，用来给变量赋初值。
;
; 不能在 Ideal1DataDirPageCreate 里初始化：静默安装时那个函数直接 Abort，
; 变量会留空，而 customInstall 仍然会执行。
;--------------------------------------------------------------------------
!macro preInit
  StrCpy $Ideal1DataDir "${IDEAL1_DEFAULT_DATA_DIR}"
!macroend

;--------------------------------------------------------------------------
; customInstall —— 文件都铺好之后执行，此时写配置最安全。
;--------------------------------------------------------------------------
!macro customInstall
  ; 已有配置就不覆盖：升级安装会再跑一次 customInstall，覆盖的话会把用户后来
  ; 在设置页里改过的路径重置回安装时选的那个——而他的数据在新路径下，重置之后
  ; 应用会打开一个空金库。**升级绝不能动用户的数据位置。**
  ${IfNot} ${FileExists} "$LOCALAPPDATA\Tessera\data-location.json"
    CreateDirectory "$LOCALAPPDATA\Tessera"
    CreateDirectory "$Ideal1DataDir"

    ; 路径里的每个反斜杠在 JSON 字符串里都要写成两个。
    ;
    ; **这行注释的写法本身是个坑**：NSIS 把行尾的反斜杠当作续行符，**注释也不
    ; 例外**。原来这句话是以「转义成 \\」结尾的，于是下面那行 ${WordReplace}
    ; 被当成注释的续行**整行吞掉**——$R0 永远不会被赋值，写出去的就是
    ; {"dataDir": ""}，Python 侧判定为无效、静默回落到默认目录。也就是说用户在
    ; 安装时选的位置会被无声无息地忽略，而这正是这一页存在的唯一理由。
    ;
    ; makensis 会报 warning 6050 提醒这件事，而 electron-builder 传了 -WX，
    ; 所以它表现为构建失败——这次是警告救了场。别把反斜杠放在行尾。
    ${WordReplace} "$Ideal1DataDir" "\" "\\" "+" $R0

    FileOpen $R1 "$LOCALAPPDATA\Tessera\data-location.json" w
    ${If} $R1 != ""
      FileWrite $R1 '{$\r$\n  "dataDir": "$R0"$\r$\n}$\r$\n'
      FileClose $R1
    ${EndIf}

    ; 同一个路径再写一份**未经转义的纯文本**，专供卸载程序读。
    ;
    ; 为什么不让卸载程序去解析上面那个 JSON：NSIS 没有 JSON 解析器，手写字符串
    ; 切分来取值，遇到路径里的引号、转义反斜杠、或者用户后来手工改过格式，取出
    ; 来的就是一段**错的路径**——而卸载那一步要对它执行 `RMDir /r`。一个解析
    ; bug 在这里的后果是删掉不该删的目录。一行纯文本没有这个风险。
    ;
    ; 这是给卸载程序的私有约定；Python 侧仍然只认 data-location.json。
    FileOpen $R2 "$LOCALAPPDATA\Tessera\data-location.txt" w
    ${If} $R2 != ""
      FileWrite $R2 "$Ideal1DataDir"
      FileClose $R2
    ${EndIf}
  ${EndIf}

  ; ---- 防火墙入站放行（尽力而为，失败绝不影响安装）----
  ;
  ; 跨设备发现全靠未经请求的入站 UDP，而 Windows 默认把它丢掉——不报错、不记
  ; 日志、socket 照常绑定成功，表现出来就是"两台机器在同一个 Wi-Fi 下，附近的
  ; 设备永远是空的"。加一条规则就能解决，问题只在于加规则要管理员权限。
  ;
  ; 这个安装包是 perMachine:false（装到用户目录、不提权），所以**大概率加不上**。
  ; 仍然试一次的理由：用户右键"以管理员身份运行"装的时候它就成了，那种情况下
  ; 他永远不会看到应用里那个提示。加不上也没有任何损失——应用启动后会自己查、
  ; 查到没放行就在界面上给一个「一键放行」按钮（走应用内的一次 UAC）。
  ;
  ; 用 nsExec::Exec 而不是 ExecWait：前者不弹控制台窗口。退出码取到 $0 之后
  ; 直接丢掉——这里没有"失败"这个概念，只有"成了"和"没成"。
  ;
  ; 只放行专用/家庭网络（domain,private）。公共网络故意不放：在机场或咖啡馆的
  ; 开放 Wi-Fi 上默认让本机可被发现，这个默认值是不对的。
  ;
  ; 按**程序**放行而不是按端口：QUIC 的监听端口是系统随机分配的，按端口放行等于
  ; 每次启动都要重加一条规则。
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${TESSERA_FIREWALL_RULE}" dir=in'
  Pop $0
  ; profile=any，不是 domain,private。Windows 默认把新网络归为「公用」，家里的
  ; Wi-Fi 绝大多数情况下就是 Public——只放 domain,private 的话规则建了也不生效，
  ; 表现和没建一模一样。放开的暴露面很小：这个进程只回答信标探测（内容与 mDNS
  ; 广播逐字段相同）和 QUIC 握手，没配对就什么都拿不到，而配对要对端亲手同意
  ; 并双向核对安全码。详见 electron/firewall.ts 里 allowThroughFirewall 的说明。
  nsExec::Exec 'netsh advfirewall firewall add rule name="${TESSERA_FIREWALL_RULE}" dir=in action=allow program="$INSTDIR\resources\crossdevice\tessera-crossdevice.exe" enable=yes profile=any'
  Pop $0
!macroend

;--------------------------------------------------------------------------
; customUnInstall —— 卸载时**不动**数据目录，也不动这份配置。
;
; deleteAppDataOnUninstall 已经是 false，这里显式留个空实现加一段注释，是为了
; 让下一个来加"清理"逻辑的人先读到这段话：卸载一个应用不该顺手删掉用户的密码库。
; 误卸载的人不该因此失去一切；真想清空的人可以自己删那个文件夹，而且安装程序在
; 卸载完成页里也会告诉他路径在哪。
;--------------------------------------------------------------------------
!macro customUnInstall
  ; ---- 真卸载时收掉登录项和系统级文件快捷键 ----
  ;
  ; 两件事都只在**真卸载**时做，自动更新走的静默卸载（--updated）一律不碰：
  ; 更新完用户的开机自启和快捷键应该原样还在。
  ;
  ; 钩子必须先停：它是独立进程，从 %LOCALAPPDATA%\Tessera\FileHook 里跑，卸载程序
  ; 删不到它。不停的话它会继续吞掉资源管理器里的 Ctrl+V / Delete，再去拉起一个
  ; 已经被删掉的后端——表现是整台电脑在资源管理器里粘贴、删除都没反应。
  ; --stop 走的是命名事件，哪一份 exe 发都一样；两份都试，因为其中一份可能已经被
  ; 安全软件删了。
  ${IfNot} ${isUpdated}
    nsExec::Exec '"$INSTDIR\resources\filehook\file_hook_worker\_internal\core\fileops\c\hook_agent.exe" --stop'
    Pop $0
    nsExec::Exec '"$INSTDIR\resources\backend\file_vault_backend\_internal\core\fileops\c\hook_agent.exe" --stop'
    Pop $0
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Ideal1FileVaultFileHook"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.ideal1.filevault"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "Ideal1FileVaultFileHook"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.ideal1.filevault"
  ${EndIf}

  ; ---- 问一次：要不要连数据一起删 ----
  ;
  ; 默认**不删**（MB_DEFBUTTON2 把默认焦点放在「否」上，直接回车 = 保留）。
  ; 金库、笔记、密码全在里面，误卸载的人不该因此失去一切。但"我确实不想在这台
  ; 机器上留下任何痕迹"也是真实需求，所以给一次明确的选择，而不是让他卸载完
  ; 再自己去找那个文件夹在哪。
  ;
  ; 静默卸载（自动更新走的就是这条路）**永远不问也永远不删**——那条路径上没有
  ; 人在看屏幕，而更新过程中删掉用户的金库是灾难性的。
  IfSilent ideal1_keep_data
  StrCpy $R3 ""
  FileOpen $R2 "$LOCALAPPDATA\Tessera\data-location.txt" r
  ${If} $R2 != ""
    FileRead $R2 $R3
    FileClose $R2
  ${EndIf}
  ; 写的时候没写换行，但这个文件被人手工编辑过就可能有，先剥掉
  ${WordReplace} "$R3" "$\r" "" "+" $R3
  ${WordReplace} "$R3" "$\n" "" "+" $R3

  ; 下面三道闸是认真的：接下来要跑的是 `RMDir /r`。
  ;   ① 路径为空——读文件失败或内容被清空，什么都不知道就什么都不删
  ;   ② 长度 < 4——挡住 "C:\" 这种盘根（对盘根跑 RMDir /r 等于清空整块盘）
  ;   ③ 目录不存在——用户早就自己删过了，没什么可问的
  StrLen $R4 "$R3"
  ${If} $R3 == ""
    Goto ideal1_keep_data
  ${EndIf}
  ${If} $R4 < 4
    Goto ideal1_keep_data
  ${EndIf}
  ${IfNot} ${FileExists} "$R3\*.*"
    Goto ideal1_keep_data
  ${EndIf}

  MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 \
    "是否连同你的数据一起删除？$\r$\n$\r$\n$R3$\r$\n$\r$\n里面是你的金库、笔记、密码和剪贴板历史，删除之后无法恢复。$\r$\n$\r$\n选「否」只卸载程序，数据原样保留，下次装回来还能接着用。" \
    IDNO ideal1_keep_data
  RMDir /r "$R3"
  Delete "$LOCALAPPDATA\Tessera\data-location.json"
  Delete "$LOCALAPPDATA\Tessera\data-location.txt"
  RMDir /r "$LOCALAPPDATA\Tessera"

ideal1_keep_data:
  ; 选了「否」（或静默卸载）时，数据目录和 data-location.json 一律不动。
  ;
  ; 防火墙规则要删掉：它指向的 exe 马上就不存在了，留着就是一条永远匹配不上的
  ; 孤儿规则。孤儿规则本身无害，但它会让**下一次**排查彻底跑偏——用户打开
  ; Windows 防火墙看到"Tessera 明明在允许列表里"，从而完全不往这个方向想。
  ;
  ; 和安装时一样：加不上/删不掉都不影响卸载，退出码取了就丢。
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${TESSERA_FIREWALL_RULE}" dir=in'
  Pop $0
!macroend
