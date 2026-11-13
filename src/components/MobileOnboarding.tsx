/**
 * @req Phase 4.5 — 手机首次进入的引导页。
 *
 * 只在窄屏、没有同步配置、且之前没关过的情况下出现；说明「数据在本机、断网可用、
 * 同步靠 PC 生成二维码」三件事，然后引导去配置或先离线使用。
 */
interface MobileOnboardingProps {
  onOpenSync: () => void;
  onDismiss: () => void;
}

export function MobileOnboarding({ onOpenSync, onDismiss }: MobileOnboardingProps) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section
        className="onboarding"
        data-testid="mobile-onboarding"
        role="dialog"
        aria-modal="true"
        aria-label="开始使用 PKE"
      >
        <h2>欢迎使用 PKE</h2>
        <p className="onboarding-lead">
          笔记保存在这台手机上，断网也能读和写；配置同步后可以和电脑互传。
        </p>
        <ol>
          <li>电脑上打开 PKE，侧栏点「同步」→「配置二维码」</li>
          <li>用手机相机扫码，服务器地址和 token 会自动填好</li>
          <li>之后两端自动同步；不配置也可以先离线使用</li>
        </ol>
        <div className="onboarding-actions">
          <button
            type="button"
            className="primary"
            data-testid="onboarding-open-sync"
            onClick={onOpenSync}
          >
            去配置同步
          </button>
          <button type="button" data-testid="onboarding-skip" onClick={onDismiss}>
            先离线使用
          </button>
        </div>
      </section>
    </div>
  );
}
