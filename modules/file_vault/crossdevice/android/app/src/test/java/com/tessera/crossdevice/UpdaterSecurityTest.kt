package com.tessera.crossdevice

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdaterSecurityTest {
    @Test
    fun updateSourcesAreLimitedToTheTwoBuiltInRepositories() {
        val main = "https://api.github.com/repos/Aevorine/Tessera/releases/latest"
        assertEquals(main, Updater.latestUrl(Updater.SOURCE_MAIN))
        assertEquals(
            "https://api.github.com/repos/Aevorine/Tessera-releases/releases/latest",
            Updater.latestUrl(Updater.SOURCE_MIRROR),
        )
        assertEquals(main, Updater.latestUrl("https://attacker.example"))
    }


    @Test
    fun trustedDownloadUrlAcceptsOnlyHttpsGitHubControlledHosts() {
        assertTrue(Updater.isTrustedDownloadUrl("https://github.com/Aevorine/Tessera/releases/download/v1/app.apk"))
        assertTrue(Updater.isTrustedDownloadUrl("https://objects.githubusercontent.com/github-production-release-asset/app.apk"))
        assertTrue(Updater.isTrustedDownloadUrl("https://release-assets.githubusercontent.com/github-production-release-asset/app.apk"))

        assertFalse(Updater.isTrustedDownloadUrl("http://github.com/Aevorine/Tessera/app.apk"))
        assertFalse(Updater.isTrustedDownloadUrl("https://github.com.evil.example/app.apk"))
        assertFalse(Updater.isTrustedDownloadUrl("https://objects.githubusercontent.com.evil.example/app.apk"))
        assertFalse(Updater.isTrustedDownloadUrl("file:///data/local/tmp/app.apk"))
    }

    @Test
    fun redirectResolutionRevalidatesAbsoluteAndRelativeTargets() {
        assertEquals(
            "https://objects.githubusercontent.com/releases/app.apk",
            Updater.resolveTrustedRedirect(
                "https://github.com/Aevorine/Tessera/releases/download/v1/app.apk",
                "https://objects.githubusercontent.com/releases/app.apk",
            ),
        )
        assertEquals(
            "https://github.com/Aevorine/Tessera/releases/download/app.apk",
            Updater.resolveTrustedRedirect(
                "https://github.com/Aevorine/Tessera/releases/download/v1/app.apk",
                "../app.apk",
            ),
        )
    }

    @Test(expected = Updater.UpdateError::class)
    fun redirectResolutionRejectsUntrustedFinalHost() {
        Updater.resolveTrustedRedirect(
            "https://github.com/Aevorine/Tessera/releases/download/v1/app.apk",
            "https://attacker.example/tessera.apk",
        )
    }
}
