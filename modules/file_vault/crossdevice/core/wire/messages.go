package wire

// CBOR 一律用整数键：紧凑，且新增字段只需占一个新整数，旧版本解析时自动忽略。
// 规范见 docs/04-线协议规范.md §5~§6。

// Hello 是连接建立后的第一条消息，做能力协商与补发定位。
type Hello struct {
	Ver          int      `cbor:"1,keyasint"`
	DeviceID     string   `cbor:"2,keyasint"`
	Name         string   `cbor:"3,keyasint"`
	Type         string   `cbor:"4,keyasint"`
	Caps         []string `cbor:"5,keyasint"`
	LastRecvSeq  uint64   `cbor:"6,keyasint"`           // 对端据此补发未确认消息
	Ticket       []byte   `cbor:"7,keyasint,omitempty"` // 会话恢复票据
	UnixMS       int64    `cbor:"8,keyasint"`
	ProtoFeature []string `cbor:"9,keyasint,omitempty"`
}

// Heartbeat 是轻量心跳，兼作状态广播。
type Heartbeat struct {
	UnixMS      int64  `cbor:"1,keyasint"`
	NetType     string `cbor:"2,keyasint,omitempty"` // wifi/cellular/ethernet
	PendingJobs int    `cbor:"3,keyasint,omitempty"`
	Nonce       uint64 `cbor:"4,keyasint"` // 回声用，用于测 RTT
	Echo        bool   `cbor:"5,keyasint,omitempty"`

	// Name 捎带本机当前设备名，对端据此更新备注。放心跳而非仅 HELLO：改名后无需重连，最多 10 秒同步。
	// omitempty + 新字段号：老版本忽略未知字段不断连（见 docs/04-线协议规范.md §11.5）。
	Name string `cbor:"6,keyasint,omitempty"`
}

// Ack 确认某条消息已收到。
type Ack struct {
	Seq uint64 `cbor:"1,keyasint"`
	Ref []byte `cbor:"2,keyasint,omitempty"` // item_id / transfer_id
}

// 错误码，见 docs/04-线协议规范.md §10。
const (
	ErrCodeProtoVersion = 1
	ErrCodeUntrusted    = 2
	ErrCodeExpired      = 3
	ErrCodeRevoked      = 4
	ErrCodeBusy         = 5
	ErrCodeRejected     = 6
	ErrCodeNoSpace      = 7
	ErrCodeBadChunk     = 8
	ErrCodePathUnsafe   = 9
	ErrCodeRateLimit    = 10
	ErrCodePairTimeout  = 11
	ErrCodeSASMismatch  = 12
)

type Error struct {
	Code int    `cbor:"1,keyasint"`
	Msg  string `cbor:"2,keyasint,omitempty"`
	Ref  []byte `cbor:"3,keyasint,omitempty"`
}

// Fatal 报告该错误是否不可重试。对可重试错误盲目放弃、
// 对不可重试错误无限重试，都是常见且难查的 bug，所以这里集中判定一次。
func (e *Error) Fatal() bool {
	switch e.Code {
	case ErrCodeProtoVersion, ErrCodeUntrusted, ErrCodeExpired,
		ErrCodeRevoked, ErrCodeRejected, ErrCodePathUnsafe, ErrCodeSASMismatch:
		return true
	}
	return false
}

// ---------- 剪贴板 ----------

// Rep 是同一份内容的一种表示形态。
// Inline 只在 size ≤ InlineRepLimit 时填充；否则接收端按需 ClipFetch。
type Rep struct {
	Mime   string `cbor:"1,keyasint"`
	Size   int64  `cbor:"2,keyasint"`
	Hash   []byte `cbor:"3,keyasint"`
	Inline []byte `cbor:"4,keyasint,omitempty"`
}

type ClipAnnounce struct {
	ItemID    []byte   `cbor:"1,keyasint"`
	HLC       string   `cbor:"2,keyasint"`
	Source    string   `cbor:"3,keyasint"`
	Preferred string   `cbor:"4,keyasint"`
	Sensitive bool     `cbor:"5,keyasint,omitempty"`
	ExpiresAt int64    `cbor:"6,keyasint,omitempty"`
	Reps      []Rep    `cbor:"7,keyasint"`
	Targets   []string `cbor:"8,keyasint,omitempty"`
	Seq       uint64   `cbor:"9,keyasint"`
	BurnAfter bool     `cbor:"10,keyasint,omitempty"`

	// CausalRef 是发出方创建此内容前自己最后见过的内容的 item_id，首次复制为空。
	// 不用于排序（HLC 已够），而是判定是否并发：接收端与自己当前 item_id 比较，对不上即两台设备
	// 互不知情地各自复制。见 node/clipxfer.go 的 checkClipConflict。
	CausalRef []byte `cbor:"11,keyasint,omitempty"`

	// Replay：发送方在重连后补发的、断线期间复制的最新内容。接收端已有更新的
	// 内容时只确认不覆盖。老版本不认识这个字段，按普通内容处理。
	Replay bool `cbor:"12,keyasint,omitempty"`

	// Force：用户手动按了"发送剪贴板"。接收端跳过回环去重窗口——用户明确要再发
	// 一次，就不该因为几秒前刚收到过同样内容而被吞掉。
	Force bool `cbor:"13,keyasint,omitempty"`
}

type ClipFetch struct {
	ItemID []byte `cbor:"1,keyasint"`
	Mime   string `cbor:"2,keyasint"`
	Offset int64  `cbor:"3,keyasint,omitempty"`
	Length int64  `cbor:"4,keyasint,omitempty"`
}

type ClipData struct {
	ItemID []byte `cbor:"1,keyasint"`
	Mime   string `cbor:"2,keyasint"`
	Offset int64  `cbor:"3,keyasint"`
	Data   []byte `cbor:"4,keyasint"`
	IsLast bool   `cbor:"5,keyasint"`
}

type ClipRevoke struct {
	ItemID []byte `cbor:"1,keyasint"`
	Reason string `cbor:"2,keyasint"`
}

// ClipHistoryReq 向对端要它最近在**它自己**那台设备上复制过的内容（剪贴板时间线）。
type ClipHistoryReq struct {
	Limit int `cbor:"1,keyasint,omitempty"`
}

// ClipHistory 是 ClipHistoryReq 的回复，新的在前。只含发出方自己复制的内容，不转手第三台设备的，
// 也不含敏感和阅后即焚内容。每条复用 ClipAnnounce 结构并校验内联正文哈希；
// Inline 只给小文本，其余仅元数据，再次粘贴时走 CLIP_FETCH。
type ClipHistory struct {
	Entries []ClipHistoryEntry `cbor:"1,keyasint"`
}

// ClipHistoryEntry 是时间线上的一条。Preview 是纯文本开头的一小段，
// 让正文没有内联的长文本也能在列表里认出来。
type ClipHistoryEntry struct {
	Item    ClipAnnounce `cbor:"1,keyasint"`
	Preview string       `cbor:"2,keyasint,omitempty"`
}

// ---------- 「接着刚才」 ----------

// Continuity 是设备对外播报的「我正在做什么」，只是一条提示、不联动跳转：
// 状态同步一旦错乱不会把用户带到没要求的地方。
// 不带正文，只有标题和本地标识（NoteID / TransferID），避免多一处泄漏面。
// 过期由接收方按 StaleAfter 对发送方墙钟毫秒 UpdatedAt 判定，因为断网、崩溃时发不出「我停了」。
type Continuity struct {
	// Kind: note | transfer | none。none 表示"我现在什么都没在做"，
	// 用来主动收回上一条提示（正常退出时发一次，属于优化不是保证）。
	Kind string `cbor:"1,keyasint"`
	// Title 是给人看的一行字，比如笔记标题或文件名。发送前已截断。
	Title string `cbor:"2,keyasint,omitempty"`
	// LocalID 是发出方那边的标识（笔记 id、传输 id）。接收方不解释，点「去看看」时原样回传，
	// 因为跨设备 id 空间不通用。
	LocalID string `cbor:"3,keyasint,omitempty"`
	// UpdatedAt 是发出方的墙钟毫秒。
	UpdatedAt int64 `cbor:"4,keyasint"`
	// DeviceName 捎带发出方的名字。接收方本来也存着一份，但那份可能还没同步到
	// 最新的改名——而这条提示的全部意义就是"**哪台**设备上还有事"。
	DeviceName string `cbor:"5,keyasint,omitempty"`
	// Progress 是 0-100，只在 Kind == transfer 时有意义。-1 表示未知。
	Progress int `cbor:"6,keyasint,omitempty"`
}

// ---------- 文件传输 ----------

type FileEntry struct {
	RelPath    string `cbor:"1,keyasint"`
	Size       int64  `cbor:"2,keyasint"`
	MerkleRoot []byte `cbor:"3,keyasint,omitempty"`
	ModTimeMS  int64  `cbor:"4,keyasint,omitempty"`
	Mode       uint32 `cbor:"5,keyasint,omitempty"`
	IsDir      bool   `cbor:"6,keyasint,omitempty"`
}

type XferOffer struct {
	TransferID []byte      `cbor:"1,keyasint"`
	FileCount  int         `cbor:"2,keyasint"`
	TotalSize  int64       `cbor:"3,keyasint"`
	ChunkSize  int         `cbor:"4,keyasint"`
	Kind       string      `cbor:"5,keyasint"` // file | files | folder | clip
	Name       string      `cbor:"6,keyasint"`
	Manifest   []FileEntry `cbor:"7,keyasint"`
	BurnAfter  bool        `cbor:"8,keyasint,omitempty"`

	// ClipItemID / ClipMime 只在 Kind == "clip" 时有值：这是剪贴板内容的某个表示借文件传输通道发送。
	// 接收端须把正文塞回对应剪贴板条目，绝不能走 ConfirmTransfer 弹窗或下载目录。见 node/clipxfer.go。
	ClipItemID []byte `cbor:"9,keyasint,omitempty"`
	ClipMime   string `cbor:"10,keyasint,omitempty"`
}

// HaveBitmap 告诉发送端"这个文件我已经有哪些块了"，是断点续传的载体。
type HaveBitmap struct {
	FileIndex int    `cbor:"1,keyasint"`
	Bitmap    []byte `cbor:"2,keyasint"`
}

type XferAccept struct {
	TransferID []byte       `cbor:"1,keyasint"`
	Have       []HaveBitmap `cbor:"2,keyasint,omitempty"`
	SkipFiles  []int        `cbor:"3,keyasint,omitempty"` // 秒传：Merkle 根相同，整文件跳过
	DestHint   string       `cbor:"4,keyasint,omitempty"`
}

type XferReject struct {
	TransferID []byte `cbor:"1,keyasint"`
	Code       int    `cbor:"2,keyasint"`
	Msg        string `cbor:"3,keyasint,omitempty"`
}

// ChunkHeader 是分块流的第一帧；随后是纯二进制数据，不再包 CBOR 以省开销。
type ChunkHeader struct {
	TransferID []byte `cbor:"1,keyasint"`
	FileIndex  int    `cbor:"2,keyasint"`
	ChunkIndex int    `cbor:"3,keyasint"`
	ChunkLen   int    `cbor:"4,keyasint"`
	Hash       []byte `cbor:"5,keyasint"`
}

type ChunkRef struct {
	FileIndex  int `cbor:"1,keyasint"`
	ChunkIndex int `cbor:"2,keyasint"`
}

type XferStatus struct {
	TransferID []byte     `cbor:"1,keyasint"`
	Action     string     `cbor:"2,keyasint"` // progress|pause|resume|cancel|resend
	BytesDone  int64      `cbor:"3,keyasint,omitempty"`
	Resend     []ChunkRef `cbor:"4,keyasint,omitempty"`
}

type XferDone struct {
	TransferID []byte `cbor:"1,keyasint"`
	OK         bool   `cbor:"2,keyasint"`
	Msg        string `cbor:"3,keyasint,omitempty"`
	Failed     []int  `cbor:"4,keyasint,omitempty"`
}

// ---------- 设备管理 ----------

type RosterEntry struct {
	DeviceID  string   `cbor:"1,keyasint"`
	Name      string   `cbor:"2,keyasint"`
	Type      string   `cbor:"3,keyasint"`
	DHPub     []byte   `cbor:"4,keyasint"`
	SignPub   []byte   `cbor:"5,keyasint"`
	Trust     string   `cbor:"6,keyasint"` // long | temp
	ExpiresAt int64    `cbor:"7,keyasint,omitempty"`
	HLC       string   `cbor:"8,keyasint"`
	Tombstone bool     `cbor:"9,keyasint,omitempty"`
	Groups    []string `cbor:"10,keyasint,omitempty"`
}

type DevRoster struct {
	Entries []RosterEntry `cbor:"1,keyasint"`
}

type DevRevoke struct {
	DeviceID string `cbor:"1,keyasint"`
	HLC      string `cbor:"2,keyasint"`
	Sig      []byte `cbor:"3,keyasint"` // 撤销人的 Ed25519 签名，防伪造
	Reason   string `cbor:"4,keyasint,omitempty"`
}

// DevIntro 是传递式信任的介绍凭据（见 docs/02 §12）。
type DevIntro struct {
	Introducer string `cbor:"1,keyasint"`
	SubjectID  string `cbor:"2,keyasint"`
	SubjectDH  []byte `cbor:"3,keyasint"`
	SubjectSig []byte `cbor:"4,keyasint"`
	ValidUntil int64  `cbor:"5,keyasint"`
	GroupID    string `cbor:"6,keyasint,omitempty"`
	Sig        []byte `cbor:"7,keyasint"`
}

// ---------- 配对 ----------

type PairHello struct {
	PairingID []byte `cbor:"1,keyasint"`
	Method    string `cbor:"2,keyasint"` // qr|code|nearby|nfc|usb|link|sound|shake|intro
	Token     []byte `cbor:"3,keyasint,omitempty"`
	Commit    []byte `cbor:"4,keyasint,omitempty"`
	DeviceID  string `cbor:"5,keyasint"`
	Name      string `cbor:"6,keyasint"`
	Type      string `cbor:"7,keyasint"`
	SignPub   []byte `cbor:"8,keyasint"`
}

type PairConfirm struct {
	Accept    bool     `cbor:"1,keyasint"`
	Mode      string   `cbor:"2,keyasint"` // long | temp
	TTLSec    int64    `cbor:"3,keyasint,omitempty"`
	Perms     []string `cbor:"4,keyasint,omitempty"`
	BurnAfter bool     `cbor:"5,keyasint,omitempty"`
}

type PairDone struct {
	Ticket  []byte        `cbor:"1,keyasint,omitempty"`
	Roster  []RosterEntry `cbor:"2,keyasint,omitempty"`
	SignPub []byte        `cbor:"3,keyasint"`
}

type PairAbort struct {
	Code int    `cbor:"1,keyasint"`
	Msg  string `cbor:"2,keyasint,omitempty"`
}
