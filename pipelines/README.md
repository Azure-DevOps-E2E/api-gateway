# Azure Pipelines CI/CD

Thư mục này chứa pipeline dùng chung cho bốn application service và pipeline
integration của toàn hệ thống. Source code đang nằm trên GitHub organization
`Azure-DevOps-E2E`, còn pipeline chạy trên Azure Pipelines.

## Các pipeline

| Pipeline trên Azure DevOps | YAML | Vai trò |
|---|---|---|
| `frontend` | `frontend/azure-pipelines.yml` | Test, build/scan image, push ACR, deploy DEV/PROD |
| `user-service` | `user-service/azure-pipelines.yml` | Như trên, test bằng Go |
| `catalog-service` | `catalog-service/azure-pipelines.yml` | Như trên, test bằng Python |
| `order-service` | `order-service/azure-pipelines.yml` | Như trên, test bằng Java/Maven |
| `platform-e2e` | `pipelines/platform-e2e.yml` | Checkout năm repo, chạy Compose và smoke test qua gateway |

Bốn pipeline service đều `extends` file
`pipelines/templates/service-pipeline.yml` trong repository `platform`. Mỗi
service chỉ truyền tên service, tên ACR repository, Dockerfile và test command.

```text
ANY BRANCH
    |
    v
CI: Test || Docker Build -> Trivy
    |
    +-- branch != main --> END
    |
    v
Push immutable BuildId tag to ACR
    |
    v
Helm deploy DEV -> health/smoke -> manual approval
    |
    v
Helm deploy PROD -> health
```

Image đã qua Trivy được đóng thành pipeline artifact ở stage CI rồi load lại ở
stage Push. Vì vậy image push lên ACR chính là image đã scan, không build lại ở
stage sau. Mỗi repository chỉ build image của chính nó.

## 1. Tạo GitHub service connection

Trong Azure DevOps, vào **Project settings > Service connections**, tạo GitHub
service connection có đúng tên:

```text
github-azure-devops-e2e
```

Connection cần quyền đọc năm repository trong organization. Tên connection là
literal trong repository resource vì Azure Pipelines không cho dùng runtime
variable ở trường này. Authorize connection cho năm pipeline, hoặc bật quyền
cho toàn project nếu chính sách của project cho phép.

## 2. Tạo variable group

Tạo Library variable group tên `nexuscart-shared` với các key sau:

| Key | Ví dụ | Ý nghĩa |
|---|---|---|
| `acrServiceConnection` | `sc-acr-nexuscart` | Docker Registry service connection tới ACR |
| `acrLoginServer` | `nexuscart.azurecr.io` | Login server, không có `https://` |
| `azureServiceConnection` | `sc-azure-nexuscart` | Azure Resource Manager service connection |
| `aksResourceGroup` | `rg-nexuscart` | Resource group chứa AKS |
| `aksClusterName` | `aks-nexuscart` | Tên AKS cluster |
| `devBaseUrl` | `https://dev.example.com` | Public URL đi qua gateway DEV |
| `prodBaseUrl` | `https://shop.example.com` | Public URL đi qua gateway PROD |
| `prodApprovers` | `team@example.com` | Email hoặc Azure DevOps group nhận approval |

Cho bốn service pipeline quyền sử dụng variable group. Không lưu Docker
password, kubeconfig hoặc Azure client secret trực tiếp trong YAML/repository;
credentials nằm trong service connection.

AKS phải có quyền pull từ ACR (ví dụ attach ACR vào kubelet identity), và Azure
service connection phải đủ quyền deploy vào hai namespace `dev` và `prod`.

## 3. Tạo environments và pipeline definitions

Tạo hai Azure Pipelines Environments:

```text
nexuscart-dev
nexuscart-prod
```

Sau đó tạo pipeline definitions theo thứ tự:

1. `frontend`, trỏ tới `/azure-pipelines.yml` của repo frontend.
2. `user-service`, trỏ tới `/azure-pipelines.yml` của repo user-service.
3. `catalog-service`, trỏ tới `/azure-pipelines.yml` của repo catalog-service.
4. `order-service`, trỏ tới `/azure-pipelines.yml` của repo order-service.
5. `platform-e2e`, trỏ tới `/pipelines/platform-e2e.yml` của repo platform.

Giữ đúng bốn tên pipeline service ở trên. `platform-e2e` dùng pipeline resource
trigger và tự chạy khi stage `CI` của một service hoàn tất thành công trên
`main`. Cách này là cần thiết vì repository resource trigger của Azure Pipelines
chỉ hỗ trợ Azure Repos, không hỗ trợ GitHub. Pipeline E2E vẫn chạy trực tiếp khi
repo `platform` thay đổi và có thể được queue thủ công.

Lần chạy đầu có thể yêu cầu bấm **Permit/Authorize resources** cho GitHub
connection, variable group, service connections, environments và bốn pipeline
resources.

## 4. Bootstrap Helm lần đầu

Các service pipeline cập nhật từng release độc lập; chúng giả định gateway và
bốn release đã được bootstrap trong environment. Với cluster mới, sau khi bốn
image đầu tiên đã có trong ACR, cài các chart theo thứ tự service trước, gateway
sau:

```bash
helm upgrade --install frontend deploy/helm/frontend -n dev --create-namespace -f deploy/helm/frontend/values-dev.yaml --set image.repository=nexuscart.azurecr.io/frontend,image.tag=<frontend-tag>,appVersion=<frontend-tag>
helm upgrade --install user-service deploy/helm/user-service -n dev -f deploy/helm/user-service/values-dev.yaml --set image.repository=nexuscart.azurecr.io/user-service,image.tag=<user-tag>,appVersion=<user-tag>
helm upgrade --install catalog-service deploy/helm/catalog-service -n dev -f deploy/helm/catalog-service/values-dev.yaml --set image.repository=nexuscart.azurecr.io/catalog-service,image.tag=<catalog-tag>,appVersion=<catalog-tag>
helm upgrade --install order-service deploy/helm/order-service -n dev -f deploy/helm/order-service/values-dev.yaml --set image.repository=nexuscart.azurecr.io/order-service,image.tag=<order-tag>,appVersion=<order-tag>
helm upgrade --install gateway deploy/helm/gateway -n dev -f deploy/helm/gateway/values-dev.yaml
```

Lặp lại với namespace `prod` và các file `values-prod.yaml`. Gateway dùng image
NGINX chính thức cùng ConfigMap nên không có pipeline build image riêng.

Sau bootstrap, mỗi service pipeline dùng `helm upgrade --install --atomic
--wait`; nếu rollout/probe lỗi, Helm tự rollback release đó. Health và smoke
test đều gọi public gateway URL, đúng luồng Browser -> Gateway -> service.

## 5. Quy tắc branch và artifact

- Mọi branch và pull request chạy test, Docker build và Trivy scan.
- Chỉ `refs/heads/main` được push ACR và deploy.
- Image tag là `Build.BuildId`, không ghi đè tag mutable như `latest`.
- Health của service vừa deploy phải trả đúng `Build.BuildId`; sai version làm
  stage verify thất bại.
- PROD chỉ chạy sau DEV health/smoke thành công và `ManualValidation` được duyệt.
- `platform-e2e` luôn build source mới nhất từ `main` của cả bốn service rồi dọn
  Compose stack bằng step `always()`.

## 6. Kiểm tra local trước khi push

Từ repository `platform`:

```powershell
docker compose config --quiet
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/health.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/smoke.ps1
```

Lint/render Helm:

```bash
for chart in frontend user-service catalog-service order-service gateway; do
  helm lint "deploy/helm/$chart"
  helm template "$chart" "deploy/helm/$chart" -f "deploy/helm/$chart/values-dev.yaml" >/dev/null
  helm template "$chart" "deploy/helm/$chart" -f "deploy/helm/$chart/values-prod.yaml" >/dev/null
done
```
