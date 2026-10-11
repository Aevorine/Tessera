package com.tessera.crossdevice

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import com.tessera.crossdevice.databinding.ActivityScanBinding
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 扫码配对：扫到配对码原样回传，由 MainActivity 发配对请求。
 * 只认出码、不做信任判断——真正的闸门是随后两端比对的安全码（SAS）；二维码本身是公开信息，无需防偷窥
 * 。
 */
class ScanActivity : AppCompatActivity() {

    companion object {
        const val EXTRA_CODE = "pairing_code"
    }

    private lateinit var ui: ActivityScanBinding
    private lateinit var analysisExecutor: ExecutorService

    /** 扫到一次就收工。不加这个的话，相机每秒几十帧、每帧都识别成功，
     *  会连着回传几十次，把配对请求打成一串重复调用。 */
    private val done = AtomicBoolean(false)

    private val requestCamera = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) startCamera() else {
            ui.textHint.text = getString(R.string.scan_need_camera)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ui = ActivityScanBinding.inflate(layoutInflater)
        setContentView(ui.root)
        analysisExecutor = Executors.newSingleThreadExecutor()

        ui.btnCancel.setOnClickListener { finish() }

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            startCamera()
        } else {
            requestCamera.launch(Manifest.permission.CAMERA)
        }
    }

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val provider = future.get()

            val preview = Preview.Builder().build().also {
                it.surfaceProvider = ui.previewView.surfaceProvider
            }

            val scanner = BarcodeScanning.getClient()
            val analysis = ImageAnalysis.Builder()
                // 只认最新一帧。识别比取流慢时，默认策略会把帧排队，
                // 于是画面里二维码早就移开了，还在处理几秒前的旧帧。
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()

            analysis.setAnalyzer(analysisExecutor) { proxy -> scan(scanner, proxy) }

            provider.unbindAll()
            provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
        }, ContextCompat.getMainExecutor(this))
    }

    @androidx.annotation.OptIn(androidx.camera.core.ExperimentalGetImage::class)
    private fun scan(scanner: com.google.mlkit.vision.barcode.BarcodeScanner, proxy: ImageProxy) {
        val media = proxy.image
        if (media == null || done.get()) {
            proxy.close()
            return
        }
        val image = InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees)
        scanner.process(image)
            .addOnSuccessListener { barcodes ->
                val code = barcodes.firstOrNull { it.format == Barcode.FORMAT_QR_CODE }?.rawValue
                // 只认本应用的配对码。相机里出现别的二维码（网址、付款码）时
                // 直接忽略，而不是把一串无关内容当配对码发出去再报错。
                if (code != null && code.startsWith("CB1:") && done.compareAndSet(false, true)) {
                    setResult(RESULT_OK, intent.putExtra(EXTRA_CODE, code))
                    finish()
                }
            }
            // 无论成功失败都必须 close，否则分析器再也拿不到新帧，画面会卡住。
            .addOnCompleteListener { proxy.close() }
    }

    override fun onDestroy() {
        analysisExecutor.shutdown()
        super.onDestroy()
    }
}
