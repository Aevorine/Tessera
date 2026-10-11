package com.tessera.crossdevice

import android.app.Activity
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import com.google.android.material.dialog.MaterialAlertDialogBuilder

object AppearanceSettingsDialog {
    fun show(
        activity: Activity,
        current: AppearanceConfig,
        onApply: (AppearanceConfig) -> Unit,
    ) {
        val content = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            val pad = dp(activity, 20)
            setPadding(pad, dp(activity, 8), pad, dp(activity, 8))
        }

        val interfaceSpinner = addSpinner(
            content,
            activity.getString(R.string.appearance_interface_mode),
            listOf(
                activity.getString(R.string.appearance_default_mode),
                activity.getString(R.string.appearance_professional_mode),
            ),
            current.interfaceMode.ordinal,
        )
        val themeSpinner = addSpinner(
            content,
            activity.getString(R.string.appearance_theme_mode),
            listOf(
                activity.getString(R.string.appearance_system),
                activity.getString(R.string.appearance_light),
                activity.getString(R.string.appearance_dark),
            ),
            current.themeMode.ordinal,
        )
        val styleSpinner = addSpinner(
            content,
            activity.getString(R.string.appearance_visual_style),
            listOf(
                activity.getString(R.string.appearance_native),
                activity.getString(R.string.appearance_oriental),
            ),
            current.visualStyle.ordinal,
        )
        val accentSpinner = addSpinner(
            content,
            activity.getString(R.string.appearance_accent),
            // 从枚举生成标签，不再手写按下标对齐的平行列表（枚举中间插入新色会整体错位且不报错）。
            // 新增色靠 accentLabelRes 的 when 穷举检查在编译期拦住遗漏。
            Accent.entries.map { activity.getString(accentLabelRes(it)) },
            current.accent.ordinal,
        )
        val decorationSpinner = addSpinner(
            content,
            activity.getString(R.string.appearance_decoration),
            listOf(
                activity.getString(R.string.appearance_decoration_off),
                activity.getString(R.string.appearance_decoration_subtle),
                activity.getString(R.string.appearance_decoration_standard),
            ),
            current.decoration.ordinal,
        )

        TextView(activity).apply {
            text = activity.getString(R.string.appearance_metrics)
            setPadding(0, dp(activity, 18), 0, dp(activity, 4))
            content.addView(this)
        }
        TextView(activity).apply {
            text = activity.getString(R.string.appearance_metrics_hint)
            alpha = 0.7f
            content.addView(this)
        }

        // 每个枚举项都必须在这张表里有一条——下面用的是 getValue，漏一项就是
        // 打开外观设置直接崩。加指标时改这两处（枚举 + 这张表）是硬性配对。
        val metricLabels = mapOf(
            AndroidMetric.ONLINE_DEVICES to R.string.metric_online_devices,
            AndroidMetric.LINK_RTT to R.string.metric_link_rtt,
            AndroidMetric.THROUGHPUT to R.string.metric_throughput,
            AndroidMetric.SESSION_TOTAL to R.string.metric_session_total,
            AndroidMetric.LISTEN_PORT to R.string.metric_listen_port,
            AndroidMetric.LOCAL_ADDRESSES to R.string.metric_local_addresses,
            AndroidMetric.INTERFACES to R.string.metric_interfaces,
            AndroidMetric.DISCOVERED to R.string.metric_discovered,
            AndroidMetric.BATTERY_TEMP to R.string.metric_battery_temp,
            AndroidMetric.CPU_CORES to R.string.metric_cpu_cores,
            AndroidMetric.DISPLAY_REFRESH to R.string.metric_display_refresh,
            AndroidMetric.APP_HEAP to R.string.metric_app_heap,
            AndroidMetric.DEVICE_MEMORY to R.string.metric_device_memory,
            AndroidMetric.STORAGE_FREE to R.string.metric_storage_free,
            AndroidMetric.BATTERY to R.string.metric_battery,
            AndroidMetric.UPTIME to R.string.metric_uptime,
            AndroidMetric.REFRESH_LATENCY to R.string.metric_refresh_latency,
        )
        val metricChecks = linkedMapOf<AndroidMetric, CheckBox>()
        AndroidMetric.entries.forEach { metric ->
            val check = CheckBox(activity).apply {
                text = activity.getString(metricLabels.getValue(metric))
                isChecked = metric in current.metrics
            }
            metricChecks[metric] = check
            content.addView(check)
        }

        val scroll = ScrollView(activity).apply {
            addView(
                content,
                ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                ),
            )
        }

        MaterialAlertDialogBuilder(activity)
            .setTitle(R.string.appearance_title)
            .setView(scroll)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.appearance_apply) { _, _ ->
                onApply(
                    AppearanceConfig(
                        interfaceMode = InterfaceMode.entries[interfaceSpinner.selectedItemPosition],
                        themeMode = ThemeMode.entries[themeSpinner.selectedItemPosition],
                        visualStyle = VisualStyle.entries[styleSpinner.selectedItemPosition],
                        accent = Accent.entries[accentSpinner.selectedItemPosition],
                        decoration = Decoration.entries[decorationSpinner.selectedItemPosition],
                        metrics = metricChecks.filterValues { it.isChecked }.keys.toList(),
                    )
                )
            }
            .show()
    }

    private fun addSpinner(
        container: LinearLayout,
        label: String,
        options: List<String>,
        selected: Int,
    ): Spinner {
        TextView(container.context).apply {
            text = label
            setPadding(0, dp(container.context as Activity, 14), 0, dp(container.context as Activity, 2))
            container.addView(this)
        }
        return Spinner(container.context).also { spinner ->
            spinner.adapter = ArrayAdapter(
                container.context,
                android.R.layout.simple_spinner_dropdown_item,
                options,
            )
            spinner.setSelection(selected)
            container.addView(spinner)
        }
    }

    private fun dp(activity: Activity, value: Int): Int =
        (value * activity.resources.displayMetrics.density).toInt()

    /**
     * 强调色 -> 设置里显示的名字。用 when 穷举，漏加名字在编译期报错；颜色映射在 AppearanceStyler.kt 同
     * 理。
     */
    private fun accentLabelRes(accent: Accent): Int = when (accent) {
        Accent.FOREST -> R.string.appearance_forest
        Accent.SKY -> R.string.appearance_sky
        Accent.INDIGO -> R.string.appearance_indigo
        Accent.VIOLET -> R.string.appearance_violet
        Accent.ROSE -> R.string.appearance_rose
        Accent.EMBER -> R.string.appearance_ember
        Accent.CLAY -> R.string.appearance_clay
        Accent.GOLD -> R.string.appearance_gold
        Accent.OLIVE -> R.string.appearance_olive
    }
}
