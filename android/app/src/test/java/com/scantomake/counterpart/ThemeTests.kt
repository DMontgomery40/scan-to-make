package com.scantomake.counterpart

import android.app.Application
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Button
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.createComposeRule
import com.scantomake.counterpart.ui.CounterpartTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [35])
class ThemeTests {
    @get:Rule val compose = createComposeRule()

    @Test fun plainContentIsReadableAndButtonsKeepTheirOwnForeground() {
        var plain: Color? = null
        var button: Color? = null
        var onPrimary: Color? = null
        compose.setContent {
            CounterpartTheme {
                Column {
                    plain = LocalContentColor.current
                    onPrimary = MaterialTheme.colorScheme.onPrimary
                    Button(onClick = {}) { button = LocalContentColor.current }
                }
            }
        }
        compose.runOnIdle {
            assertEquals("Plain headings and estimates must be readable on the dark canvas", Color.White, plain)
            assertEquals(onPrimary, button)
            assertEquals(Color.Black, button)
        }
    }
}
