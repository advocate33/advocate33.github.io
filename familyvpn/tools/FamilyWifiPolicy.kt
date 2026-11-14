// SPDX-License-Identifier: GPL-3.0-or-later
// FamilyVPN: detect connected physical Wi-Fi, never inspect Wi-Fi SSIDs.
package com.wdtt.plus

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities

/** Marker used only by the existing TrustedWifi waiting state, not a real SSID. */
internal const val FAMILY_WIFI_PSEUDO_SSID = "Wi-Fi"

internal object FamilyWifiPolicy {
    /** True when any non-VPN Wi-Fi network is connected, even without Internet.
     * A mobile connection may remain available in parallel; Wi-Fi takes priority.
     */
    fun isConnected(context: Context): Boolean {
        val manager = context.applicationContext
            .getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
            ?: return true // Fail closed rather than unexpectedly tunnel over Wi-Fi.
        return runCatching {
            manager.allNetworks.any { network ->
                val caps = manager.getNetworkCapabilities(network)
                caps != null &&
                    caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) &&
                    caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)
            }
        }.getOrDefault(true) // On an API failure do not start the VK tunnel.
    }
}
