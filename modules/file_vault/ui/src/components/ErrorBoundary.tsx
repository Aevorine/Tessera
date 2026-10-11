import { Component, type ErrorInfo, type ReactNode } from 'react'
import { withTranslation, type WithTranslation } from 'react-i18next'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FeatureTitle } from '@/components/ui/page'
import { reportUiFailure } from '@/lib/diagnostics'

interface Props extends WithTranslation {
  children: ReactNode
}

interface State {
  error: Error | null
  info: ErrorInfo | null
}

// React error boundary 只能是 class 组件（hook 抓不到自己渲染时抛的错）。没有它，树里任何渲染期未处
// 理错误都会让整个应用白屏且无法恢复，即项目规格点名的"崩溃后必须重启"。
class ErrorBoundaryImpl extends Component<Props, State> {
  state: State = { error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] caught a render error:', error, info.componentStack)
    // 同时写进故障日志。console 只在开着开发者工具时看得见，而"整页白掉"
    // 恰恰是用户最常报、最难复现的那一类——事后能翻到记录才追得下去。
    reportUiFailure('ui', '界面渲染崩溃', error)
    this.setState({ info })
  }

  handleReload = (): void => {
    window.location.reload()
  }

  render() {
    const { error, info } = this.state
    const { t } = this.props
    if (!error) return this.props.children

    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-8">
        <div className="flex max-w-md flex-col items-center gap-4 text-center">
          <AlertTriangle className="h-10 w-10 text-destructive" />
          <FeatureTitle as="h2">{t('errorBoundaryTitle')}</FeatureTitle>
          <Button onClick={this.handleReload}>{t('errorBoundaryReloadButton')}</Button>
          <details className="w-full text-left">
            <summary className="cursor-pointer text-sm text-muted-foreground">
              {t('errorBoundaryDetailsToggle')}
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 text-sm text-muted-foreground">
              {error.message}
              {info?.componentStack ?? ''}
            </pre>
          </details>
        </div>
      </div>
    )
  }
}

export const ErrorBoundary = withTranslation('common')(ErrorBoundaryImpl)
