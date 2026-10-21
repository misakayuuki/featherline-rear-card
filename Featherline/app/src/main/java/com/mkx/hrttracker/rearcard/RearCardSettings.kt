package com.mkx.hrttracker.rearcard

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.activity.compose.LocalActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.mkx.hrttracker.widget.WidgetSnapshotRepository
import com.mkx.hrttracker.ui.security.AppLockViewModel
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

data class RearCardUiState(
    val enabled: Boolean = false,
    val busy: Boolean = false,
    val message: String = "尚未开启背屏同步",
    val launchIntent: Intent? = null,
)

@HiltViewModel
class RearCardViewModel @Inject constructor(
    @param:ApplicationContext private val context: Context,
    private val widgetRepository: WidgetSnapshotRepository,
    private val savedState: SavedStateHandle,
) : ViewModel() {
    private val publisher = RearCardPublisher.get(context)
    private val mutable = MutableStateFlow(RearCardUiState(
        publisher.isEnabled,
        message = publisher.lastStatus,
        launchIntent = savedState.get<Intent>("pendingLaunchIntent"),
    ))
    val state = mutable.asStateFlow()
    val pendingImport = savedState.getStateFlow<String?>("pendingUri", null)

    fun enableAndBind() = runAction {
        if (pendingImport.value != null) return@runAction
        publisher.enable()
        widgetRepository.refreshWidgetSnapshot()
        val prepared = publisher.prepareForeground()
        if (prepared == null) {
            mutable.value = RearCardUiState(publisher.isEnabled, message = "正在准备最新数据。请等待首页加载完成，再点“发送并绑定”。")
        } else {
            val intent = publisher.foregroundIntent(prepared)
            savedState["pendingUri"] = prepared.uri.toString()
            savedState["pendingRequestId"] = prepared.requestId
            savedState["pendingLaunchIntent"] = intent
            mutable.value = RearCardUiState(publisher.isEnabled, message = "请在卡片桥选择背屏载体，完成后返回。", launchIntent = intent)
        }
    }
    fun launched() {
        savedState["pendingLaunchIntent"] = null
        mutable.value = mutable.value.copy(launchIntent = null)
    }
    fun launchFailed() {
        cleanupPending()
        mutable.value = mutable.value.copy(message = "无法打开卡片桥，请先安装支持 API 2 的 rear-card-bridge。", launchIntent = null)
    }
    fun syncNow() = runAction {
        if (!publisher.isEnabled || pendingImport.value != null) return@runAction
        widgetRepository.refreshWidgetSnapshot()
        mutable.value = RearCardUiState(publisher.isEnabled, message = publisher.lastStatus)
    }
    fun disable() = runAction {
        // Revoke the file immediately, but retain the in-flight request until its Activity returns.
        // Otherwise a cancelled result without an ID could be mistaken for a newer import.
        if (savedState.get<Intent>("pendingLaunchIntent") != null) cleanupPending()
        else pendingImport.value?.let { publisher.cleanupUri(Uri.parse(it)) }
        val result = publisher.disableAndClear()
        mutable.value = RearCardUiState(false, message = result.message)
    }
    fun imported(data: Intent?) {
        if (pendingImport.value == null) return
        val requestId = data?.getStringExtra("request_id")
        if (requestId != null && requestId != savedState.get<String>("pendingRequestId")) return
        // Results must release their URI even while another operation is busy.
        cleanupPending()
        if (!publisher.isEnabled) return
        val status = data?.getStringExtra("status")
        val message = when (status) {
            "SAVED" -> "数据已保存到卡片桥，背屏将在系统下次读取时更新。"
            "BINDING_REQUIRED" -> "模块已保存。请在卡片桥中选择载体并完成绑定。"
            "CARRIER_WRITTEN", "SETTINGS_OPENED" -> "请在系统背屏设置移除旧卡，再重新应用这个载体。"
            else -> "未确认绑定完成。请在卡片桥检查模块状态，或重新发送。"
        }
        publisher.recordForegroundResult(data?.extras)
        mutable.value = mutable.value.copy(enabled = publisher.isEnabled, message = message, launchIntent = null)
    }
    private fun cleanupPending() {
        savedState.get<String>("pendingUri")?.let { publisher.cleanupUri(Uri.parse(it)) }
        savedState["pendingUri"] = null
        savedState.remove<String>("pendingRequestId")
        savedState["pendingLaunchIntent"] = null
    }
    private fun runAction(action: suspend () -> Unit) {
        if (mutable.value.busy) return
        mutable.value = mutable.value.copy(busy = true, launchIntent = null)
        viewModelScope.launch {
            try { action() }
            catch (error: CancellationException) { throw error }
            catch (_: Exception) { mutable.value = RearCardUiState(publisher.isEnabled, message = "操作未完成，请检查卡片桥后重试。") }
            finally { mutable.value = mutable.value.copy(busy = false, enabled = publisher.isEnabled) }
        }
    }
}

@Composable
fun RearCardSettingsDialog(onDismiss: () -> Unit, viewModel: RearCardViewModel = hiltViewModel()) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val pendingImport by viewModel.pendingImport.collectAsStateWithLifecycle()
    val activity = LocalActivity.current as ComponentActivity
    val appLockViewModel: AppLockViewModel = hiltViewModel(viewModelStoreOwner = activity)
    val lock by appLockViewModel.uiState.collectAsStateWithLifecycle()
    val canShow = lock.isReady && !lock.shouldShowLockScreen
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        viewModel.imported(result.data)
    }
    LaunchedEffect(state.launchIntent, canShow) {
        if (!canShow) return@LaunchedEffect
        state.launchIntent?.let { intent ->
            viewModel.launched()
            try { launcher.launch(intent) } catch (_: RuntimeException) { viewModel.launchFailed() }
        }
    }
    // A Material dialog has its own window; keep it below the app's authentication gate.
    // Register the Activity result launcher above this gate so a returning import can be cleaned up.
    if (!canShow) return
    AlertDialog(
        onDismissRequest = { if (!state.busy && pendingImport == null) onDismiss() },
        title = { Text("Featherline 背屏") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("显示雌二醇模型估算值、下一次计划用药倒计时和今日记录进度。记录或计划变化后自动推送，后台按原有小组件机制择机更新。")
                Text("开启后，这些摘要会存入卡片桥并出现在背屏上，Featherline 的应用锁不再保护这份副本。沿用“隐藏用药详情”设置；浓度仍会显示。")
                Text(if (state.enabled) "同步已开启" else "同步已关闭")
                Button(onClick = viewModel::enableAndBind, enabled = !state.busy && pendingImport == null, modifier = Modifier.fillMaxWidth()) {
                    Text(if (state.enabled) "发送并绑定" else "开启同步并绑定")
                }
                OutlinedButton(onClick = viewModel::syncNow, enabled = state.enabled && !state.busy && pendingImport == null, modifier = Modifier.fillMaxWidth()) { Text("立即同步") }
                OutlinedButton(onClick = viewModel::disable, enabled = !state.busy, modifier = Modifier.fillMaxWidth()) { Text("关闭并清空显示") }
                Text(state.message)
                if (pendingImport != null) Text("绑定窗口仍在进行中，请从卡片桥返回后再发送。")
                Text("首次绑定后，需要在系统背屏设置重新应用载体。倒计时表示计划时间，不自动记录用药。超过 30 分钟未同步会提示缓存；系统休眠可能暂停背屏刷新。若要立即删除桥内副本，请在卡片桥卸载本模块。")
            }
        },
        confirmButton = { TextButton(onClick = onDismiss, enabled = !state.busy && pendingImport == null) { Text("返回") } },
    )
}
