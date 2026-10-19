package com.tessera.crossdevice

import java.text.Normalizer
import java.util.Locale

/**
 * 首页搜索的纯逻辑引擎：查询解析、归一化、打分、排序。不碰任何界面类，拼音由外部注入。
 * 语义与桌面端同一套：空格分词全部 AND；"短语" 整体匹配；-词 排除；字段:值 限定字段（全角冒号同样认）。
 */

/** 拼音来源：返回一个汉字的小写 ASCII 拼音，取不到返回 null。 */
fun interface PinyinProvider {
    fun pinyinOf(ch: Char): String?
}

/** 条目上的一个可搜字段。keys 是能用「字段:」前缀命中它的规范名（device / file / clip / ip / type / from / status …）。 */
class SearchField(val keys: Set<String>, val text: String, val weight: Double = 1.0) {
    constructor(key: String, text: String, weight: Double = 1.0) : this(setOf(key), text, weight)
}

/** 查询里的一个词。field 为 null 表示不限字段。 */
class QueryTerm(val text: String, val field: String?, val exclude: Boolean, val exact: Boolean = false)

class SmartQuery(val raw: String, val terms: List<QueryTerm>) {
    val isEmpty: Boolean get() = terms.isEmpty()

    /** 需要高亮的词：排除词不高亮。 */
    val positive: List<QueryTerm> get() = terms.filter { !it.exclude }

    companion object {
        val EMPTY = SmartQuery("", emptyList())
    }
}

class SearchHit<T>(val item: T, val score: Double)

/** 一个词在一段文字里的命中：分数与原文中的区间（左闭右开）。 */
class TermMatch(val score: Int, val ranges: List<IntRange>)

class SmartSearch(private val pinyin: PinyinProvider?) {

    companion object {
        const val SCORE_EXACT = 100
        const val SCORE_PREFIX = 80
        const val SCORE_WORD = 70
        const val SCORE_SUBSTRING = 50
        const val SCORE_PINYIN = 40
        const val SCORE_TYPO = 25
        const val SCORE_SUBSEQ = 15
        private const val PINYIN_SPAN = 200
        private const val CACHE_MAX = 4096

        /** 字段别名 → 规范名。键均为归一化（小写半角）后的形式。 */
        val FIELD_ALIASES: Map<String, String> = mapOf(
            "device" to "device", "dev" to "device", "name" to "device", "设备" to "device", "名称" to "device",
            "file" to "file", "文件" to "file",
            "clip" to "clip", "clipboard" to "clip", "剪贴板" to "clip",
            "ip" to "ip", "addr" to "ip", "address" to "ip", "地址" to "ip",
            "type" to "type", "kind" to "type", "类型" to "type",
            "from" to "from", "source" to "from", "peer" to "from", "来源" to "from",
            "status" to "status", "state" to "status", "状态" to "status",
            "id" to "id",
            "folder" to "folder", "dir" to "folder", "文件夹" to "folder", "目录" to "folder",
            "size" to "size", "大小" to "size",
        )

        /** 归一化：NFKC（全角转半角）+ 小写。 */
        fun normalize(s: String): String =
            Normalizer.normalize(s, Normalizer.Form.NFKC).lowercase(Locale.ROOT)

        /** 解析查询。未知字段前缀整词当普通文本；「字段:」后为空的词忽略（正在输入时不至于什么都不剩）。 */
        fun parse(query: String): SmartQuery {
            val q = normalize(query)
            val terms = ArrayList<QueryTerm>()
            var i = 0
            val n = q.length
            while (i < n) {
                while (i < n && q[i].isWhitespace()) i++
                if (i >= n) break
                var exclude = false
                if (q[i] == '-' && i + 1 < n && !q[i + 1].isWhitespace()) {
                    exclude = true
                    i++
                }
                var field: String? = null
                if (q[i] != '"') {
                    // 找本词内第一个冒号：前面是已知字段名才算限定。
                    var j = i
                    while (j < n && !q[j].isWhitespace() && q[j] != ':' && q[j] != '"') j++
                    if (j < n && q[j] == ':' && j > i) {
                        val alias = FIELD_ALIASES[q.substring(i, j)]
                        if (alias != null) {
                            field = alias
                            i = j + 1
                        }
                    }
                }
                val exact = i < n && q[i] == '"'
                val text: String
                if (i < n && q[i] == '"') {
                    val close = q.indexOf('"', i + 1)
                    val end = if (close < 0) n else close
                    text = q.substring(i + 1, end).trim()
                    i = if (close < 0) n else close + 1
                } else {
                    var j = i
                    while (j < n && !q[j].isWhitespace()) j++
                    text = q.substring(i, j)
                    i = j
                }
                // 空引号、只写了「字段:」之类：跳过。
                if (text.isNotEmpty()) terms += QueryTerm(text, field, exclude, exact)
            }
            return SmartQuery(query, terms)
        }

        private fun isHan(ch: Char): Boolean =
            Character.UnicodeScript.of(ch.code) == Character.UnicodeScript.HAN

        /** 最优对齐的 Damerau-Levenshtein 距离是否 ≤ 1。 */
        private fun withinOneEdit(a: String, b: String): Boolean {
            val la = a.length
            val lb = b.length
            if (kotlin.math.abs(la - lb) > 1) return false
            if (la == lb) {
                var i = 0
                while (i < la && a[i] == b[i]) i++
                if (i == la) return true
                // 一处替换，或相邻两字互换。
                if (a.regionMatches(i + 1, b, i + 1, la - i - 1)) return true
                return i + 1 < la && a[i] == b[i + 1] && a[i + 1] == b[i] &&
                    a.regionMatches(i + 2, b, i + 2, la - i - 2)
            }
            val (s, l) = if (la < lb) a to b else b to a
            var i = 0
            while (i < s.length && s[i] == l[i]) i++
            return s.regionMatches(i, l, i + 1, s.length - i)
        }
    }

    /** 一段文字的归一化形式与到原文的下标映射，按原文缓存，每秒刷新的列表不必重复算。 */
    private inner class Norm(raw: String) {
        val text: String
        private val rawStart: IntArray
        private val rawEnd: IntArray
        val words: List<IntRange>
        val hasHan: Boolean
        private var py: Array<String?>? = null

        init {
            val sb = StringBuilder(raw.length)
            val st = ArrayList<Int>(raw.length)
            val en = ArrayList<Int>(raw.length)
            var i = 0
            while (i < raw.length) {
                val cp = raw.codePointAt(i)
                val cc = Character.charCount(cp)
                val piece = if (cp < 0x80) raw.substring(i, i + cc)
                else Normalizer.normalize(raw.substring(i, i + cc), Normalizer.Form.NFKC)
                for (c in piece.lowercase(Locale.ROOT)) {
                    sb.append(c)
                    st += i
                    en += i + cc
                }
                i += cc
            }
            text = sb.toString()
            rawStart = st.toIntArray()
            rawEnd = en.toIntArray()
            val w = ArrayList<IntRange>()
            var k = 0
            while (k < text.length) {
                if (!text[k].isLetterOrDigit()) { k++; continue }
                val s = k
                while (k < text.length && text[k].isLetterOrDigit()) k++
                w += s until k
            }
            words = w
            hasHan = text.any { isHan(it) }
        }

        fun pinyinArray(): Array<String?>? {
            val p = pinyin ?: return null
            py?.let { return it }
            val lim = minOf(text.length, PINYIN_SPAN)
            val arr = arrayOfNulls<String>(lim)
            for (k in 0 until lim) if (isHan(text[k])) arr[k] = p.pinyinOf(text[k])?.takeIf { it.isNotEmpty() }
            py = arr
            return arr
        }

        /** 归一化区间 [a, b) 换回原文区间。 */
        fun toRaw(a: Int, b: Int): IntRange = rawStart[a] until rawEnd[b - 1]
    }

    private val cache = object : LinkedHashMap<String, Norm>(256, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Norm>?): Boolean = size > CACHE_MAX
    }

    private fun norm(raw: String): Norm = synchronized(cache) {
        cache[raw] ?: Norm(raw).also { cache[raw] = it }
    }

    /** 一个（已归一化的）词对一段原文的最佳命中；不中返回 null。依次尝试，先中者为准。 */
    fun match(term: String, raw: String, fuzzy: Boolean = true, exact: Boolean = false): TermMatch? {
        if (term.isEmpty() || raw.isEmpty()) return null
        val f = norm(raw)
        val t = f.text
        val m = term.length
        if (t == term) return TermMatch(SCORE_EXACT, listOf(f.toRaw(0, t.length)))
        if (t.startsWith(term)) return TermMatch(SCORE_PREFIX, listOf(f.toRaw(0, m)))
        for (w in f.words) {
            if (w.first > 0 && t.regionMatches(w.first, term, 0, m)) {
                return TermMatch(SCORE_WORD, listOf(f.toRaw(w.first, w.first + m)))
            }
        }
        val at = t.indexOf(term)
        if (at >= 0) return TermMatch(SCORE_SUBSTRING, listOf(f.toRaw(at, at + m)))
        if (exact) return null
        if (f.hasHan && term.all { it in 'a'..'z' }) {
            pinyinMatch(f, term)?.let { (s, e) -> return TermMatch(SCORE_PINYIN, listOf(f.toRaw(s, e))) }
        }
        if (!fuzzy) return null
        if (m >= 5) {
            for (w in f.words) {
                if (withinOneEdit(term, t.substring(w.first, w.last + 1))) {
                    return TermMatch(SCORE_TYPO, listOf(f.toRaw(w.first, w.last + 1)))
                }
            }
        }
        if (m >= 3) subsequence(t, term)?.let { pos ->
            return TermMatch(SCORE_SUBSEQ, pos.map { f.toRaw(it, it + 1) })
        }
        return null
    }

    /** 拼音：从某个汉字起连续一串汉字，每个字可匹配全拼或其任意前缀。只看前 200 字。 */
    private fun pinyinMatch(f: Norm, term: String): Pair<Int, Int>? {
        val py = f.pinyinArray() ?: return null
        val lim = py.size
        val m = term.length
        // 失败过的 (字位置, 词位置) 与起点无关，记下来避免回溯爆炸。
        val dead = BooleanArray((lim + 1) * (m + 1))
        fun go(i: Int, p: Int): Int {
            if (p == m) return i
            if (i >= lim) return -1
            val syl = py[i] ?: return -1
            val key = i * (m + 1) + p
            if (dead[key]) return -1
            var k = minOf(syl.length, m - p)
            while (k >= 1) {
                if (syl.regionMatches(0, term, p, k)) {
                    val r = go(i + 1, p + k)
                    if (r >= 0) return r
                }
                k--
            }
            dead[key] = true
            return -1
        }
        for (s in 0 until lim) {
            if (py[s] == null) continue
            val e = go(s, 0)
            if (e >= 0) return s to e
        }
        return null
    }

    /** 子序列：按序出现，跨度 ≤ 3 × 词长；取跨度最小的一组位置。 */
    private fun subsequence(t: String, term: String): List<Int>? {
        val m = term.length
        val maxSpan = 3 * m
        var best: IntArray? = null
        var bestSpan = Int.MAX_VALUE
        var s = t.indexOf(term[0])
        while (s >= 0) {
            val pos = IntArray(m)
            pos[0] = s
            var j = 1
            var k = s + 1
            while (j < m && k < t.length && k - s < maxSpan) {
                if (t[k] == term[j]) pos[j++] = k
                k++
            }
            if (j == m) {
                val span = pos[m - 1] - s + 1
                if (span < bestSpan) {
                    bestSpan = span
                    best = pos
                }
            }
            s = t.indexOf(term[0], s + 1)
        }
        return best?.toList()
    }

    /** 一个词在条目各字段上的最佳加权分；不中返回 -1。 */
    private fun termScore(term: QueryTerm, fields: List<SearchField>, fuzzy: Boolean): Double {
        var best = -1.0
        for (fd in fields) {
            if (term.field != null && term.field !in fd.keys) continue
            val mt = match(term.text, fd.text, fuzzy && !term.exclude, term.exact) ?: continue
            val v = mt.score * fd.weight
            if (v > best) best = v
        }
        return best
    }

    /** 过滤并排序。空查询原样返回、不过滤；同分保持原顺序。 */
    fun <T> filter(items: List<T>, query: SmartQuery, fieldsOf: (T) -> List<SearchField>): List<SearchHit<T>> {
        if (query.isEmpty) return items.map { SearchHit(it, 0.0) }
        fun run(fuzzy: Boolean): List<SearchHit<T>> {
        val out = ArrayList<SearchHit<T>>()
        outer@ for (item in items) {
            val fields = fieldsOf(item)
            var total = 0.0
            for (term in query.terms) {
                val s = termScore(term, fields, fuzzy)
                if (term.exclude) {
                    if (s >= 0) continue@outer
                } else {
                    if (s < 0) continue@outer
                    total += s
                }
            }
            out += SearchHit(item, total)
        }
        // sortedByDescending 是稳定排序。
        return out.sortedByDescending { it.score }
        }
        val strict = run(false)
        return if (strict.isEmpty() && query.terms.any { !it.exclude && !it.exact }) run(true) else strict
    }

    /** 给一段可见文字算高亮区间（原文下标）：每个正向词各取一处命中。 */
    fun highlightRanges(query: SmartQuery, raw: String): List<IntRange> {
        if (raw.isEmpty()) return emptyList()
        val out = ArrayList<IntRange>()
        for (term in query.positive) match(term.text, raw, exact = term.exact)?.let { out += it.ranges }
        return out
    }
}
