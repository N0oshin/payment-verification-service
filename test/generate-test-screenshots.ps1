<#
.SYNOPSIS
  Generates two synthetic payment-screenshot PNGs for testing POST /api/payment-verification/verify,
  using .NET System.Drawing (no external tools/dependencies needed).

.DESCRIPTION
  Writes postman-test-approved.png (amount = -ApprovedAmount, correct payee/sort-code/account) and
  postman-test-rejected.png (a deliberately wrong amount and payee) into the service's uploads dir.
  Run this BEFORE the Postman collection's "Verify - Requires Generated Fixtures" folder, after
  setting that collection's testOrderNumber/testOrderTotal variables to a real pending order.

.EXAMPLE
  .\generate-test-screenshots.ps1 -ApprovedAmount 112.00
#>
param(
  [Parameter(Mandatory = $true)][decimal]$ApprovedAmount,
  [decimal]$RejectedAmount = ($ApprovedAmount + 999),
  [string]$UploadsDir = (Join-Path $PSScriptRoot "..\uploads")
)

Add-Type -AssemblyName System.Drawing

function New-TextImage($text, $path) {
  $bmp = New-Object System.Drawing.Bitmap 800, 500
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::White)
  $font = New-Object System.Drawing.Font("Arial", 28, [System.Drawing.FontStyle]::Regular)
  $brush = [System.Drawing.Brushes]::Black
  $g.DrawString($text, $font, $brush, (New-Object System.Drawing.PointF(20, 20)))
  $g.Dispose()
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

if (-not (Test-Path $UploadsDir)) {
  New-Item -ItemType Directory -Force -Path $UploadsDir | Out-Null
}

$approvedAmountStr = "{0:N2}" -f $ApprovedAmount
$rejectedAmountStr = "{0:N2}" -f $RejectedAmount

$goodText = "Payment Sent`n`nAmount: GBP $approvedAmountStr`n`nTo: HSA INTERPAY UK`nSort Code: 60-95-61`nAccount: 21327124`n`nStatus: Successful"
$goodPath = Join-Path $UploadsDir "postman-test-approved.png"
New-TextImage $goodText $goodPath

$badText = "Payment Sent`n`nAmount: GBP $rejectedAmountStr`n`nTo: Some Other Bank`n`nStatus: Successful"
$badPath = Join-Path $UploadsDir "postman-test-rejected.png"
New-TextImage $badText $badPath

Write-Output "Generated:"
Write-Output "  $goodPath (amount $approvedAmountStr - should score APPROVED against an order with that exact total)"
Write-Output "  $badPath (amount $rejectedAmountStr, wrong payee - should score REJECTED against any order)"
